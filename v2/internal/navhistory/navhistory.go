// Package navhistory is where you have been, for the back and forward arrows: the places opened, in order, with a cursor
// on the one you are at. Going back and then somewhere new drops what was ahead, as a browser's history does, and
// opening the place you are already at changes nothing.
package navhistory

const limit = 100

type History[P comparable] struct {
	places []P
	at     int
}

// Push records that somebody went to p.
func (h *History[P]) Push(p P) {
	if h.at < len(h.places) && h.places[h.at] == p {
		return
	}
	h.places = append(h.places[:min(h.at+1, len(h.places))], p)
	if len(h.places) > limit {
		h.places = h.places[len(h.places)-limit:]
	}
	h.at = len(h.places) - 1
}

// Back moves to the place before this one and returns it; ok is false at the start.
func (h *History[P]) Back() (p P, ok bool) {
	if !h.CanBack() {
		return p, false
	}
	h.at--
	return h.places[h.at], true
}

func (h *History[P]) Forward() (p P, ok bool) {
	if !h.CanForward() {
		return p, false
	}
	h.at++
	return h.places[h.at], true
}

func (h *History[P]) CanBack() bool    { return h.at > 0 && h.at < len(h.places) }
func (h *History[P]) CanForward() bool { return h.at < len(h.places)-1 }

// Current is the place you are at.
func (h *History[P]) Current() (p P, ok bool) {
	if h.at < len(h.places) {
		return h.places[h.at], true
	}
	return p, false
}

// Drop takes a place that no longer exists out of the list; going on skips over it.
func (h *History[P]) Drop(p P) {
	var current P
	have := h.at < len(h.places)
	if have {
		current = h.places[h.at]
	}
	kept := h.places[:0]
	for _, q := range h.places {
		if q != p {
			kept = append(kept, q)
		}
	}
	if len(kept) == len(h.places) {
		return
	}
	h.places = kept
	h.at = len(kept) - 1
	if have {
		for i, q := range kept {
			if q == current {
				h.at = i
			}
		}
	}
	h.at = max(h.at, 0)
}

func (h *History[P]) Clear() { h.places, h.at = h.places[:0], 0 }
