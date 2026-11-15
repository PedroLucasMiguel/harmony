// Package sharegov lowers a screen share's frame rate and size when this computer cannot encode it as fast as it is asked
// to, and raises them again when it can: a game that starves the encoder still gets a steady 30 fps at 720p through it,
// which is a far better stream than 8 fps at 1080p. It is the Electron client's share-governor.js, given a reading every
// second or so; it touches nothing itself.
//
// Starved means: behind on frames (under 70% of those asked for), the encoder slow to the frame (over 25 ms; a hardware
// one takes 1-5), and the link not the reason. Six seconds of that steps down; half a minute of the encoder keeping up steps
// up one, and a step up that is met by being starved again at once is not tried again for a while, which doubles each time.
package sharegov

import (
	"math"
	"time"
)

// Priority is what is given up first.
type Priority int

const (
	// Sharp keeps the picture's size and lowers the frame rate first.
	Sharp Priority = iota
	// Smooth keeps the frame rate and makes the picture smaller first.
	Smooth
)

type rung struct{ fps, shrink float64 }

var ladders = [2][]rung{
	Sharp:  {{1, 1}, {0.5, 1}, {0.5, 1.5}, {0.34, 2}},
	Smooth: {{1, 1}, {1, 1.5}, {1, 2}, {0.5, 2}},
}

const (
	minFPS    = 15
	minHeight = 360

	behind      = 0.7
	slowEncode  = 25.0
	keepingUp   = 0.9
	fastEncode  = 12.0
	linkRoom    = 1.05
	window      = 4 * time.Second
	stepDown    = 6
	stepUp      = 30
	settle      = 3
	probe       = 12
	holdFirst   = 60
	holdMax     = 600
	minIdleSecs = 2.0
)

// Ask is what the person chose: the ceiling. Width and Height are 0 for "native".
type Ask struct {
	FPS           int
	Width, Height int
}

// Plan is what to apply: the frame rate and the size, 0 for the source's own.
type Plan struct {
	Rung          int
	FPS           int
	Width, Height int
	Lowered       bool
}

// Sample is one reading. Frames and EncodeSeconds are running totals.
type Sample struct {
	At            time.Time
	Frames        uint64
	EncodeSeconds float64
	// LinkLimited says the link, not this computer, holds the picture back (loss, or an estimate at what is sent).
	LinkLimited   bool
	Width, Height int
}

type reading struct {
	seconds float64
	frames  float64
	encode  float64
}

// Governor is the state of one share.
type Governor struct {
	prio     Priority
	ceiling  Ask
	seen     Ask
	rung     int
	last     *Sample
	behind   int
	keeping  int
	settling int
	recent   []reading
	hold     int
	holdFor  int
	probing  int
}

// New starts a governor for a share asked at ask.
func New(ask Ask, prio Priority) *Governor {
	return &Governor{prio: prio, ceiling: ask, seen: ask, holdFor: holdFirst}
}

func even(n float64) int { return max(2, int(math.Round(n/2))*2) }

// Plan is what the share is at now.
func (g *Governor) Plan() Plan {
	step := ladders[g.prio][g.rung]
	if g.rung == 0 {
		return Plan{FPS: g.ceiling.FPS, Width: g.ceiling.Width, Height: g.ceiling.Height}
	}
	fps := max(min(minFPS, g.ceiling.FPS), int(math.Round(float64(g.ceiling.FPS)*step.fps)))
	baseW, baseH := g.ceiling.Width, g.ceiling.Height
	if baseH == 0 {
		baseW, baseH = g.seen.Width, g.seen.Height
	}
	shrink := step.shrink
	if baseH > 0 && float64(baseH)/shrink < minHeight {
		shrink = max(1, float64(baseH)/minHeight)
	}
	p := Plan{Rung: g.rung, FPS: fps, Lowered: true}
	if baseH > 0 {
		p.Width, p.Height = even(float64(baseW)/shrink), even(float64(baseH)/shrink)
	}
	return p
}

// Ask says the person changed what they ask for: it is the new ceiling and what was learned is let go.
func (g *Governor) Ask(next Ask, prio Priority) Plan {
	g.ceiling, g.prio = next, prio
	if next.Width > 0 {
		g.seen.Width, g.seen.Height = next.Width, next.Height
	}
	g.rung, g.behind, g.keeping, g.settling, g.recent, g.last = 0, 0, 0, settle, nil, nil
	return g.Plan()
}

func (g *Governor) move(to int) *Plan {
	g.rung, g.behind, g.keeping, g.settling, g.recent = to, 0, 0, settle, nil
	p := g.Plan()
	return &p
}

// Sample takes one reading and returns what to apply, or nil for no change.
func (g *Governor) Sample(s Sample) *Plan {
	if g.rung == 0 && s.Width > 0 && s.Height > 0 {
		g.seen.Width, g.seen.Height = s.Width, s.Height
	}
	before := g.last
	g.last = &s
	if before == nil || !s.At.After(before.At) {
		return nil
	}
	g.hold = max(0, g.hold-1)
	g.probing = max(0, g.probing-1)
	if g.settling > 0 {
		g.settling--
		return nil
	}
	if s.Frames < before.Frames {
		return nil
	}
	g.recent = append(g.recent, reading{
		seconds: s.At.Sub(before.At).Seconds(), frames: float64(s.Frames - before.Frames), encode: max(0, s.EncodeSeconds-before.EncodeSeconds),
	})
	var span float64
	for _, r := range g.recent {
		span += r.seconds
	}
	for len(g.recent) > 1 && span-g.recent[0].seconds >= window.Seconds() {
		span -= g.recent[0].seconds
		g.recent = g.recent[1:]
	}
	if span < window.Seconds()/2 {
		return nil
	}
	var frames, encode float64
	for _, r := range g.recent {
		frames += r.frames
		encode += r.encode
	}
	if frames == 0 {
		return nil
	}
	fps := frames / span
	encodeMs := encode / frames * 1000
	asked := float64(g.Plan().FPS)
	starved := !s.LinkLimited && fps < asked*behind && encodeMs > slowEncode
	easy := fps >= asked*keepingUp && encodeMs < fastEncode

	if starved {
		g.keeping = 0
		g.behind++
		if g.behind >= stepDown && g.rung < len(ladders[g.prio])-1 {
			if g.probing > 0 {
				g.hold = g.holdFor
				g.holdFor = min(holdMax, g.holdFor*2)
			}
			g.probing = 0
			return g.move(g.rung + 1)
		}
		return nil
	}
	g.behind = 0
	if g.rung > 0 && easy && g.hold == 0 {
		g.keeping++
		if g.keeping >= stepUp {
			p := g.move(g.rung - 1)
			g.probing = probe + settle
			return p
		}
	} else {
		g.keeping = 0
	}
	return nil
}
