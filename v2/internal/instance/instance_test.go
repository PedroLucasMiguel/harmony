package instance

import (
	"testing"
	"time"
)

func TestSecondLaunchIsTurnedAway(t *testing.T) {
	profile := t.TempDir()
	first := Acquire(profile)
	defer first.Close()
	shown := make(chan struct{}, 1)
	first.Serve(func() { shown <- struct{}{} })
	if Acquire(profile) != nil {
		t.Fatal("a second instance was let in")
	}
	select {
	case <-shown:
	case <-time.After(2 * time.Second):
		t.Fatal("the first was not asked to show itself")
	}
}
