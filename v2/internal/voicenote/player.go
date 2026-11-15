package voicenote

import (
	"sync"
	"time"

	"harmony/v2/internal/audio"
)

const (
	pace    = 20 * time.Millisecond
	ahead   = 160
	block   = rate / 50
	nearEnd = 0.05
)

// Player plays one track at a time through the mixer: play, pause, seek and speed. Nothing runs while it is paused.
type Player struct {
	mixer    *audio.Mixer
	onChange func()

	mu      sync.Mutex
	key     string
	reader  *reader
	src     *audio.Source
	stop    chan struct{}
	speed   float64
	buf     []int16
	started func()
	stopped func()
	open    bool
}

// NewPlayer makes a player that mixes into the given mixer; onChange is called, from any goroutine, when what it shows has changed. started and stopped, if set, are called when sound begins and when nothing is left playing, to open and close the sound card.
func NewPlayer(mixer *audio.Mixer, onChange, started, stopped func()) *Player {
	return &Player{mixer: mixer, onChange: onChange, speed: 1, buf: make([]int16, block*2), started: started, stopped: stopped}
}

// Key is what is loaded, as given to Play.
func (p *Player) Key() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.key
}

// Playing says whether sound is coming out of the key's track.
func (p *Player) Playing(key string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.key == key && p.stop != nil
}

// Speed is the pace it plays at: 1 is as recorded.
func (p *Player) Speed() float64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.speed
}

// Position is how far into the track the sound heard now is, in frames; ok is false when the key is not the loaded one.
func (p *Player) Position(key string) (frames float64, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.key != key || p.reader == nil {
		return 0, false
	}
	return p.positionLocked(), true
}

func (p *Player) positionLocked() float64 {
	at := p.reader.Pos()
	if p.src != nil {
		at -= float64(p.src.Buffered()) * rate / 1000 * p.speed
	}
	return max(at, 0)
}

// Load makes a track the current one, stopping whatever was playing; it starts at the beginning, unplayed.
func (p *Player) Load(key string, t Track) {
	p.mu.Lock()
	p.loadLocked(key, t)
	p.mu.Unlock()
	p.onChange()
}

func (p *Player) loadLocked(key string, t Track) {
	if p.key != key {
		p.haltLocked()
		p.releaseLocked()
		p.key, p.reader = key, newReader(t)
		p.reader.SetSpeed(p.speed)
	}
}

// Play starts the track from where it was left, or from where seek says: negative for no change. Another track that was playing is stopped.
func (p *Player) Play(key string, t Track, seek int) {
	p.mu.Lock()
	p.loadLocked(key, t)
	if seek >= 0 {
		p.reader.Seek(seek)
	} else if int(p.reader.Pos()) >= t.Frames()-int(nearEnd*rate) {
		p.reader.Seek(0)
	}
	p.startLocked()
	p.mu.Unlock()
	p.onChange()
}

// Pause stops the sound where it is.
func (p *Player) Pause() {
	p.mu.Lock()
	if p.stop != nil && p.reader != nil {
		at := int(p.positionLocked())
		p.haltLocked()
		p.reader.Seek(at)
		p.releaseLocked()
	}
	p.mu.Unlock()
	p.onChange()
}

// Seek moves the loaded track to a frame, playing or not.
func (p *Player) Seek(key string, frame int) {
	p.mu.Lock()
	if p.key == key && p.reader != nil {
		playing := p.stop != nil
		if playing {
			p.haltLocked()
		}
		p.reader.Seek(frame)
		if playing {
			p.startLocked()
		}
	}
	p.mu.Unlock()
	p.onChange()
}

// SetSpeed changes the pace for this and the next tracks.
func (p *Player) SetSpeed(s float64) {
	p.mu.Lock()
	if p.reader != nil {
		playing := p.stop != nil
		at := int(p.positionLocked())
		p.speed = s
		if playing {
			p.haltLocked()
			p.reader.Seek(at)
		}
		p.reader.SetSpeed(s)
		if playing {
			p.startLocked()
		}
	} else {
		p.speed = s
	}
	p.mu.Unlock()
	p.onChange()
}

// Unload forgets the loaded track, stopping it.
func (p *Player) Unload() {
	p.mu.Lock()
	p.haltLocked()
	p.releaseLocked()
	p.key, p.reader = "", nil
	p.mu.Unlock()
	p.onChange()
}

func (p *Player) startLocked() {
	if p.stop != nil {
		return
	}
	if !p.open && p.started != nil {
		p.started()
	}
	p.open = true
	p.src = p.mixer.NewSource("voice message")
	p.stop = make(chan struct{})
	go p.run(p.src, p.stop, p.reader)
}

func (p *Player) haltLocked() {
	if p.stop == nil {
		return
	}
	close(p.stop)
	p.mixer.Remove(p.src)
	p.stop, p.src = nil, nil
}

// releaseLocked tells the owner nothing is playing any more, so the sound card can be let go of.
func (p *Player) releaseLocked() {
	if p.open && p.stopped != nil {
		p.stopped()
	}
	p.open = false
}

func (p *Player) run(src *audio.Source, stop chan struct{}, r *reader) {
	tick := time.NewTicker(pace)
	defer tick.Stop()
	ended := false
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
		}
		p.mu.Lock()
		if p.stop != stop {
			p.mu.Unlock()
			return
		}
		for !ended && src.Buffered() < ahead {
			n := r.Read(p.buf)
			if n == 0 {
				ended = true
				break
			}
			src.Push(p.buf[:n*2])
		}
		if ended && src.Buffered() == 0 {
			p.haltLocked()
			p.releaseLocked()
			r.Seek(0)
			p.mu.Unlock()
			p.onChange()
			return
		}
		p.mu.Unlock()
		p.onChange()
	}
}
