// Package music is Music Buddy's listening side: the server's state of a channel's music, the clock it is followed by, and the player that makes the sound.
package music

import (
	"math"
	"sync"
	"time"
)

// Status is what the server says the music is doing.
const (
	Idle    = "idle"
	Loading = "loading"
	Playing = "playing"
	Paused  = "paused"
)

// Track is one song of the queue as the server describes it.
type Track struct {
	ID         string   `json:"id"`
	Source     string   `json:"source"`
	Title      string   `json:"title"`
	Artist     string   `json:"artist"`
	DurationMs int64    `json:"durationMs"`
	ThumbHash  string   `json:"thumbHash"`
	AddedBy    string   `json:"addedBy"`
	Hash       string   `json:"hash"`
	GainDb     *float64 `json:"gainDb"`
	Error      string   `json:"error"`
}

// Level is the multiplier that brings the track to the common loudness the server measured, or 1 when it did not.
func (t Track) Level() float64 {
	if t.GainDb == nil {
		return 1
	}
	return math.Pow(10, *t.GainDb/20)
}

// State is the whole of a channel's music. A State is never changed once it has been handed out.
type State struct {
	Rev        int     `json:"rev"`
	Status     string  `json:"status"`
	Current    string  `json:"current"`
	StartedAt  int64   `json:"startedAt"`
	PositionMs int64   `json:"positionMs"`
	Shuffle    bool    `json:"shuffle"`
	Repeat     string  `json:"repeat"`
	Queue      []Track `json:"queue"`
}

// Now is the track that is current, or nil.
func (s *State) Now() *Track {
	if s == nil || s.Current == "" {
		return nil
	}
	for i := range s.Queue {
		if s.Queue[i].ID == s.Current {
			return &s.Queue[i]
		}
	}
	return nil
}

// Live is whether there is a song to show: one that is loading, playing or paused.
func (s *State) Live() bool {
	return s.Now() != nil && (s.Status == Loading || s.Status == Playing || s.Status == Paused)
}

// Snapshot is what the server sends with joining and with every change: the state, and what its clock read when it was sent.
type Snapshot struct {
	State     *State `json:"state"`
	ServerNow int64  `json:"serverNow"`
}

// Beat is the heartbeat: where the music is, without the queue.
type Beat struct {
	Rev        int    `json:"rev"`
	Status     string `json:"status"`
	StartedAt  int64  `json:"startedAt"`
	PositionMs int64  `json:"positionMs"`
	ServerNow  int64  `json:"serverNow"`
}

const rttSamples = 5

// Mirror follows a channel's music: the last state, and the arithmetic that says where in the track it ought to be now.
//
// The server's clock when a snapshot was sent is known, and how long a push takes to arrive is half the shortest of the
// last few measured round trips; with those, what the server's clock reads now is known, and so is the position.
type Mirror struct {
	now func() time.Time

	mu        sync.Mutex
	state     *State
	serverNow int64
	at        time.Time
	rtts      []time.Duration
}

// NewMirror makes an empty mirror that reads this computer's clock with now (time.Now when nil).
func NewMirror(now func() time.Time) *Mirror {
	if now == nil {
		now = time.Now
	}
	return &Mirror{now: now}
}

// Apply takes a snapshot, or none for no music.
func (m *Mirror) Apply(s *Snapshot) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s == nil || s.State == nil {
		m.state = nil
		return
	}
	m.state, m.serverNow, m.at = s.State, s.ServerNow, m.now()
}

// Tick takes a heartbeat; it is false when the heartbeat is for a state this mirror does not have, and the whole of it must be asked for.
func (m *Mirror) Tick(b Beat) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state == nil || m.state.Rev != b.Rev {
		return false
	}
	next := *m.state
	next.Status, next.StartedAt, next.PositionMs = b.Status, b.StartedAt, b.PositionMs
	m.state, m.serverNow, m.at = &next, b.ServerNow, m.now()
	return true
}

// Calibrate takes the round trip of a request for the server's clock.
func (m *Mirror) Calibrate(rtt time.Duration) {
	if rtt < 0 {
		return
	}
	m.mu.Lock()
	m.rtts = append(m.rtts, rtt)
	if len(m.rtts) > rttSamples {
		m.rtts = m.rtts[len(m.rtts)-rttSamples:]
	}
	m.mu.Unlock()
}

// Latency is how long a push from the server takes to arrive, as measured.
func (m *Mirror) Latency() time.Duration {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.latency()
}

func (m *Mirror) latency() time.Duration {
	if len(m.rtts) == 0 {
		return 0
	}
	best := m.rtts[0]
	for _, r := range m.rtts {
		best = min(best, r)
	}
	return best / 2
}

// State is the music as last told, or nil; it must not be changed.
func (m *Mirror) State() *State {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state
}

// Calibrated is whether any round trip has been measured yet.
func (m *Mirror) Calibrated() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.rtts) > 0
}

// Position is where in the current track the music ought to be now.
func (m *Mirror) Position() time.Duration {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.position()
}

func (m *Mirror) position() time.Duration {
	s := m.state
	if s == nil {
		return 0
	}
	switch s.Status {
	case Playing:
		serverNow := m.serverNow + (m.latency() + m.now().Sub(m.at)).Milliseconds()
		return max(0, time.Duration(serverNow-s.StartedAt)*time.Millisecond)
	case Paused:
		return time.Duration(s.PositionMs) * time.Millisecond
	}
	return 0
}
