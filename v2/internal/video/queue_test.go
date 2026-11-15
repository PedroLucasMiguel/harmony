package video

import (
	"io"
	"testing"
	"time"
)

func TestQueueDropsTheOldestAndEndsWithItsReason(t *testing.T) {
	q := newAUQueue(2)
	for i := byte(1); i <= 4; i++ {
		q.push([]byte{i})
	}
	for _, want := range []byte{3, 4} {
		au, ok, err := q.next(time.Second)
		if err != nil || !ok || len(au) != 1 || au[0] != want {
			t.Fatalf("got %v %v %v; want %d", au, ok, err, want)
		}
	}
	if _, ok, err := q.next(10 * time.Millisecond); ok || err != nil {
		t.Fatalf("an empty queue should time out, got %v %v", ok, err)
	}
	q.push([]byte{9})
	q.fail(io.ErrUnexpectedEOF)
	if au, ok, _ := q.next(time.Second); !ok || au[0] != 9 {
		t.Fatal("what was queued must be taken before the failure")
	}
	if _, _, err := q.next(time.Second); err != io.ErrUnexpectedEOF {
		t.Fatalf("got %v", err)
	}
}

func TestQueueCloseWakesTheReader(t *testing.T) {
	q := newAUQueue(2)
	done := make(chan error)
	go func() { _, _, err := q.next(0); done <- err }()
	time.Sleep(10 * time.Millisecond)
	q.close()
	select {
	case err := <-done:
		if err != io.EOF {
			t.Fatalf("got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("close did not wake the reader")
	}
}

func TestQueueReusesBuffers(t *testing.T) {
	q := newAUQueue(2)
	au := make([]byte, 1000)
	q.push(au)
	q.next(0)
	allocs := testing.AllocsPerRun(100, func() {
		q.push(au)
		q.next(0)
	})
	if allocs > 0 {
		t.Errorf("%v allocations a picture", allocs)
	}
}

func TestQueueSaysWhenItDrops(t *testing.T) {
	q := newAUQueue(1)
	drops := 0
	q.onDrop = func() { drops++ }
	q.push([]byte{1})
	q.push([]byte{2})
	q.push([]byte{3})
	if drops != 2 {
		t.Fatalf("%d drops; want 2", drops)
	}
}
