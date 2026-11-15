package music

import (
	"sync"
	"time"

	"harmony/v2/internal/audio"
)

const (
	pace = 20 * time.Millisecond
	// ahead is how much decoded sound is kept waiting in the mixer's source.
	ahead = 160
	block = rate / 50
	// DriftMs is how far off the sound may be before it is moved: less than that is not heard as a difference.
	DriftMs = 150
	fadeIn  = rate / 100
)

// Want is what the music should be doing: which file, whether it sounds, and how loud.
type Want struct {
	Key     string
	Path    string
	Playing bool
	Gain    float64
}

// Player makes the sound of one track at a time through the mixer, from a file read as it plays, and keeps it where it is told it should be.
type Player struct {
	mixer *audio.Mixer

	mu    sync.Mutex
	key   string
	file  *File
	src   *audio.Source
	stop  chan struct{}
	gain  float64
	buf   []int16
	ended bool
}

// NewPlayer makes a player that mixes into the given mixer.
func NewPlayer(mixer *audio.Mixer) *Player {
	return &Player{mixer: mixer, buf: make([]int16, block*2)}
}

// Update says what the music should be doing and where in the track it should be now. The sound is started when it is not sounding,
// moved when it is more than DriftMs from where it should be, and stopped when it should be silent.
func (p *Player) Update(w Want, at time.Duration) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if w.Key != p.key {
		p.releaseLocked()
		if w.Path == "" {
			return nil
		}
		f, err := OpenFile(w.Path)
		if err != nil {
			return err
		}
		p.key, p.file = w.Key, f
	}
	p.gain = w.Gain
	if p.src != nil {
		p.src.SetGain(w.Gain)
	}
	if p.file == nil {
		return nil
	}
	want := int(at.Seconds() * rate)
	if !w.Playing || w.Gain <= 0 || want >= p.file.Frames() {
		p.haltLocked()
		return nil
	}
	if p.stop != nil && abs(p.heardLocked()-want) <= DriftMs*rate/1000 {
		return nil
	}
	p.haltLocked()
	p.file.Seek(want)
	p.startLocked()
	return nil
}

// Heard is where in the track the sound that is coming out now is; ok is false while nothing sounds.
func (p *Player) Heard() (time.Duration, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stop == nil {
		return 0, false
	}
	return time.Duration(p.heardLocked()) * time.Second / rate, true
}

// Stop silences the music and lets go of its file.
func (p *Player) Stop() {
	p.mu.Lock()
	p.releaseLocked()
	p.mu.Unlock()
}

func (p *Player) heardLocked() int {
	return p.file.Pos() - p.src.Buffered()*rate/1000
}

func (p *Player) releaseLocked() {
	p.haltLocked()
	if p.file != nil {
		p.file.Close()
	}
	p.key, p.file = "", nil
}

func (p *Player) startLocked() {
	p.src = p.mixer.NewSource("music")
	p.src.SetGain(p.gain)
	p.stop, p.ended = make(chan struct{}), false
	first := true
	for p.src.Buffered() < ahead {
		if !p.fillLocked(first) {
			break
		}
		first = false
	}
	go p.run(p.src, p.stop)
}

func (p *Player) haltLocked() {
	if p.stop == nil {
		return
	}
	close(p.stop)
	p.mixer.Remove(p.src)
	p.stop, p.src = nil, nil
}

// fillLocked decodes one block into the source; a fresh start fades in so that moving into the middle of a sound does not click.
func (p *Player) fillLocked(fresh bool) bool {
	n := p.file.Read(p.buf)
	if n == 0 {
		p.ended = true
		return false
	}
	if fresh {
		for i := 0; i < min(n, fadeIn); i++ {
			g := int32(i) * 256 / fadeIn
			p.buf[2*i] = int16(int32(p.buf[2*i]) * g >> 8)
			p.buf[2*i+1] = int16(int32(p.buf[2*i+1]) * g >> 8)
		}
	}
	p.src.Push(p.buf[:n*2])
	return true
}

func (p *Player) run(src *audio.Source, stop chan struct{}) {
	tick := time.NewTicker(pace)
	defer tick.Stop()
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
		for !p.ended && src.Buffered() < ahead {
			if !p.fillLocked(false) {
				break
			}
		}
		p.mu.Unlock()
		if p.ended {
			return
		}
	}
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
