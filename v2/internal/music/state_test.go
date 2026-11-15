package music

import (
	"testing"
	"time"
)

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time { return c.t }

func playing(startedAt int64) *Snapshot {
	return &Snapshot{ServerNow: startedAt + 5000, State: &State{Rev: 3, Status: Playing, Current: "t1", StartedAt: startedAt, Queue: []Track{{ID: "t1"}}}}
}

func TestPositionFollowsTheServersClock(t *testing.T) {
	clock := &fakeClock{t: time.Unix(100, 0)}
	m := NewMirror(clock.now)
	m.Apply(playing(1_000_000))
	if got := m.Position(); got != 5*time.Second {
		t.Fatalf("at arrival the position is %v, want 5s", got)
	}
	m.Calibrate(80 * time.Millisecond)
	m.Calibrate(40 * time.Millisecond)
	m.Calibrate(300 * time.Millisecond)
	clock.t = clock.t.Add(2 * time.Second)
	if got := m.Position(); got != 7*time.Second+20*time.Millisecond {
		t.Fatalf("two seconds later, with 20 ms of travel, the position is %v", got)
	}
}

func TestPausedHoldsItsPosition(t *testing.T) {
	clock := &fakeClock{t: time.Unix(100, 0)}
	m := NewMirror(clock.now)
	m.Apply(&Snapshot{ServerNow: 9, State: &State{Rev: 1, Status: Paused, Current: "t1", PositionMs: 12_345, Queue: []Track{{ID: "t1"}}}})
	clock.t = clock.t.Add(time.Minute)
	if got := m.Position(); got != 12_345*time.Millisecond {
		t.Fatalf("paused position %v", got)
	}
}

func TestBeatOnlyFitsTheStateItIsFor(t *testing.T) {
	clock := &fakeClock{t: time.Unix(100, 0)}
	m := NewMirror(clock.now)
	m.Apply(playing(1_000_000))
	if m.Tick(Beat{Rev: 4}) {
		t.Fatal("a beat for another revision was taken")
	}
	if !m.Tick(Beat{Rev: 3, Status: Paused, PositionMs: 700, ServerNow: 1}) {
		t.Fatal("a beat for this revision was refused")
	}
	if s := m.State(); s.Status != Paused || len(s.Queue) != 1 || m.Position() != 700*time.Millisecond {
		t.Fatalf("the beat was not applied: %+v", s)
	}
}

func TestLevelFromDecibels(t *testing.T) {
	down := -20.0
	if got := (Track{GainDb: &down}).Level(); got < 0.0999 || got > 0.1001 {
		t.Fatalf("-20 dB is %v", got)
	}
	if (Track{}).Level() != 1 {
		t.Fatal("an unmeasured track has level 1")
	}
}
