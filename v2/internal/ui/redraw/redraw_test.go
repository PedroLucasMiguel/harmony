package redraw

import (
	"testing"
	"time"
)

func reset() {
	requested.Store(false)
	deadline.Store(0)
	waker.Store(nil)
}

func TestSleepWaitsForTheNextDeadline(t *testing.T) {
	reset()
	var waited []time.Duration
	wait := func(d time.Duration) { waited = append(waited, d) }

	Sleep(wait)
	After(time.Hour)
	Sleep(wait)
	Request()
	Sleep(wait)
	Take()
	After(-time.Second)
	Sleep(wait)

	if len(waited) != 2 || waited[0] != 0 || waited[1] < 59*time.Minute || waited[1] > time.Hour {
		t.Fatalf("waits %v: want one unbounded, one of about an hour, and none when a frame is already due", waited)
	}
}

func TestRequestWakesOnlyASleepingLoop(t *testing.T) {
	reset()
	woken := 0
	SetWaker(func() { woken++ })

	Request()
	After(time.Hour)
	if woken != 0 {
		t.Fatalf("woke %d times while the loop was awake", woken)
	}
	Take()
	Sleep(func(time.Duration) { Request(); After(time.Millisecond) })
	if woken != 2 {
		t.Fatalf("woke %d times while sleeping, want 2", woken)
	}
}
