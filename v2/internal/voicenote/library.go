package voicenote

import (
	"container/list"
	"sync"
)

// held is how many bytes of decoded or compressed sound the library keeps at once; what is only drawn, the length and the bars, costs nothing to keep.
const held = 32 << 20

// Load fetches a sound file's bytes.
type Load func() ([]byte, error)

// Status is where a sound's preparation has got to.
type Status uint8

const (
	Loading Status = iota
	Ready
	Failed
)

// Library prepares sounds off the calling goroutine and remembers how they look; the sound itself is kept only for the few used last.
type Library struct {
	onChange func()

	mu      sync.Mutex
	entries map[string]*entry
	used    list.List
	bytes   int
}

type entry struct {
	key    string
	status Status
	info   Info
	track  Track
	at     *list.Element
}

// NewLibrary makes a library; onChange is called, from any goroutine, when a sound has become ready.
func NewLibrary(onChange func()) *Library {
	return &Library{onChange: onChange, entries: map[string]*entry{}}
}

// Info is what the sound looks like, and where its preparation is; the first call for a key starts it.
func (l *Library) Info(key string, load Load) (Info, Status) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.entries[key]
	if e == nil {
		e = &entry{key: key}
		l.entries[key] = e
		go l.prepare(e, load)
	}
	return e.info, e.status
}

// Track is the sound ready to play, fetched again if it was let go of; it blocks, so it is asked for from a goroutine.
func (l *Library) Track(key string, load Load) (Track, error) {
	l.mu.Lock()
	e := l.entries[key]
	if e != nil && e.track != nil {
		l.used.MoveToBack(e.at)
		t := e.track
		l.mu.Unlock()
		return t, nil
	}
	l.mu.Unlock()
	data, err := load()
	if err != nil {
		return nil, err
	}
	t, err := Open(data)
	if err == nil && e != nil {
		l.mu.Lock()
		l.keep(e, t)
		l.mu.Unlock()
	}
	return t, err
}

func (l *Library) prepare(e *entry, load Load) {
	data, err := load()
	var track Track
	if err == nil {
		track, err = Open(data)
	}
	var info Info
	if err == nil {
		info = Analyse(track)
	}
	l.mu.Lock()
	if err != nil {
		e.status = Failed
	} else {
		e.status, e.info = Ready, info
		l.keep(e, track)
	}
	l.mu.Unlock()
	l.onChange()
}

// keep holds a track for an entry and lets go of the ones used longest ago when there is too much; the caller has the lock.
func (l *Library) keep(e *entry, t Track) {
	if e.track != nil {
		return
	}
	e.track = t
	e.at = l.used.PushBack(e)
	l.bytes += t.Size()
	for l.bytes > held && l.used.Len() > 1 {
		old := l.used.Front().Value.(*entry)
		l.used.Remove(old.at)
		l.bytes -= old.track.Size()
		old.track, old.at = nil, nil
	}
}
