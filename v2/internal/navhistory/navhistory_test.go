package navhistory

import "testing"

func TestBackAndForwardWalkTheTrail(t *testing.T) {
	var h History[string]
	for _, p := range []string{"a", "b", "c", "c"} {
		h.Push(p)
	}
	if p, _ := h.Back(); p != "b" {
		t.Fatalf("back = %q", p)
	}
	if p, _ := h.Back(); p != "a" || h.CanBack() {
		t.Fatalf("back = %q, can back %v", p, h.CanBack())
	}
	if p, _ := h.Forward(); p != "b" || !h.CanForward() {
		t.Fatalf("forward = %q", p)
	}
}

func TestGoingSomewhereNewDropsWhatWasAhead(t *testing.T) {
	var h History[string]
	h.Push("a")
	h.Push("b")
	h.Back()
	h.Push("c")
	if h.CanForward() {
		t.Fatal("c should be the end of the trail")
	}
	if p, _ := h.Back(); p != "a" {
		t.Fatalf("back from c = %q", p)
	}
}

func TestDropKeepsTheCursorOnTheCurrentPlace(t *testing.T) {
	var h History[string]
	for _, p := range []string{"a", "b", "c"} {
		h.Push(p)
	}
	h.Back()
	h.Drop("a")
	if p, _ := h.Current(); p != "b" || h.CanBack() || !h.CanForward() {
		t.Fatalf("current %q back %v forward %v", p, h.CanBack(), h.CanForward())
	}
}

func TestTheTrailIsBounded(t *testing.T) {
	var h History[int]
	for i := range 250 {
		h.Push(i)
	}
	n := 0
	for h.CanBack() {
		h.Back()
		n++
	}
	if n != limit-1 {
		t.Fatalf("walked back %d places", n)
	}
}
