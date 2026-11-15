package widget

import (
	"unicode/utf8"

	"harmony/v2/internal/ui/emojitext"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
)

// pickRun is a piece of a laid out text that can be selected: a line fragment or a picture standing for its :name:.
type pickRun struct {
	r     geom.Rect
	text  string
	style paint.TextStyle
	off   int
	n     int
	image bool
}

// pickState is what selecting in a RichText needs, built only when a selection first touches it.
type pickState struct {
	ox, oy         float32
	built          bool
	plain          []rune
	runs           []pickRun
	selFrom, selTo int
	rects          []geom.Rect
	rectsFrom      int
	rectsTo        int
	rectsOK        bool
}

func (r *RichText) build(c *Context) {
	p := &r.pick
	if p.built {
		return
	}
	p.built = true
	add := func(breaks uint8, run pickRun) {
		for ; breaks > 0 && len(p.plain) > 0; breaks-- {
			p.plain = append(p.plain, '\n')
		}
		run.off = len(p.plain)
		for _, ch := range run.text {
			p.plain = append(p.plain, ch)
		}
		run.n = len(p.plain) - run.off
		p.runs = append(p.runs, run)
	}
	image := 0
	addImages := func(upTo int) {
		for ; image < len(r.images) && r.images[image].after <= upTo; image++ {
			im := r.images[image]
			add(im.breaks, pickRun{r: im.r, text: im.alt, image: true})
		}
	}
	for i, f := range r.frags {
		addImages(i)
		if f.marker {
			continue
		}
		lh := f.lh
		if lh == 0 {
			lh = f.style.Size * 1.5
		}
		w := f.width
		if w == 0 {
			w = c.Paint.TextWidth(f.text, f.style)
		}
		add(f.breaks, pickRun{r: geom.Rect{X: f.x, Y: f.y, W: w, H: lh}, text: f.text, style: f.style})
	}
	addImages(len(r.frags))
}

// Plain is the text as it reads, without the marks of its layout: what copying it gives.
func (r *RichText) Plain(c *Context) []rune {
	r.build(c)
	return r.pick.plain
}

// SetSelection marks the characters from to as selected; they are drawn so on the next Draw.
func (r *RichText) SetSelection(from, to int) { r.pick.selFrom, r.pick.selTo = from, to }

// Origin is where the text was last drawn.
func (r *RichText) Origin() (x, y float32) { return r.pick.ox, r.pick.oy }

// OffsetAt is the character boundary nearest to a point, in window coordinates, as an index into Plain.
func (r *RichText) OffsetAt(c *Context, mx, my float32) int {
	r.build(c)
	runs := r.pick.runs
	if len(runs) == 0 {
		return 0
	}
	x, y := mx-r.pick.ox, my-r.pick.oy
	best, bestD := 0, float32(1e9)
	for i := range runs {
		d := y - (runs[i].r.Y + runs[i].r.H/2)
		if d < 0 {
			d = -d
		}
		if d < bestD-0.5 {
			best, bestD = i, d
		}
	}
	mid := runs[best].r.Y + runs[best].r.H/2
	band := runs[best].r.H / 2
	last := best
	for i := range runs {
		run := &runs[i]
		d := mid - (run.r.Y + run.r.H/2)
		if d < -band || d > band {
			continue
		}
		last = i
		if x < run.r.X+run.r.W {
			return r.within(c, run, x)
		}
	}
	return runs[last].off + runs[last].n
}

func (r *RichText) within(c *Context, run *pickRun, x float32) int {
	if x <= run.r.X {
		return run.off
	}
	x -= run.r.X
	if run.image {
		if x < run.r.W/2 {
			return run.off
		}
		return run.off + run.n
	}
	prev := float32(0)
	chars := 0
	for at := 0; at < len(run.text); {
		next := at + emojitext.ClusterLen(run.text[at:])
		w := c.Paint.TextWidth(run.text[:next], run.style)
		if x < (prev+w)/2 {
			return run.off + chars
		}
		chars += utf8.RuneCountInString(run.text[at:next])
		prev, at = w, next
	}
	return run.off + run.n
}

func (r *RichText) drawSelection(c *Context, x, y float32) {
	p := &r.pick
	if p.selFrom >= p.selTo {
		return
	}
	r.build(c)
	if !p.rectsOK || p.rectsFrom != p.selFrom || p.rectsTo != p.selTo {
		p.rects, p.rectsFrom, p.rectsTo, p.rectsOK = p.rects[:0], p.selFrom, p.selTo, true
		for i := range p.runs {
			run := &p.runs[i]
			a, b := max(p.selFrom, run.off)-run.off, min(p.selTo, run.off+run.n)-run.off
			if a >= b {
				continue
			}
			if run.image {
				p.rects = append(p.rects, run.r)
				continue
			}
			left := c.Paint.TextWidth(runePrefix(run.text, a), run.style)
			right := c.Paint.TextWidth(runePrefix(run.text, b), run.style)
			p.rects = append(p.rects, geom.Rect{X: run.r.X + left, Y: run.r.Y, W: right - left, H: run.r.H})
		}
	}
	for _, rc := range p.rects {
		c.Paint.Fill(geom.Rect{X: x + rc.X, Y: y + rc.Y, W: rc.W, H: rc.H}, 0, selectionColor(c))
	}
}

// WordAt is the word around character index off of the text.
func (r *RichText) WordAt(c *Context, off int) (from, to int) { return wordAt(r.Plain(c), off) }

// LineAt is the paragraph around character index off of the text.
func (r *RichText) LineAt(c *Context, off int) (from, to int) { return lineAt(r.Plain(c), off, true) }

// LinkAt is the address of the link under a point in window coordinates, or "".
func (r *RichText) LinkAt(mx, my float32) string {
	for _, l := range r.links {
		if (geom.Rect{X: r.pick.ox + l.r.X, Y: r.pick.oy + l.r.Y, W: l.r.W, H: l.r.H}).Contains(mx, my) {
			return l.url
		}
	}
	return ""
}

type selPoint struct{ id, off int }

func (a selPoint) before(b selPoint) bool { return a.id < b.id || a.id == b.id && a.off < b.off }

// TextSelection is a selection that runs through the texts of a view, each told apart by an ordered id (a log's messages).
type TextSelection struct {
	anchor, focus selPoint
	drag          dragMode
	origin        [2]selPoint
}

// Active tells whether any text is selected.
func (s *TextSelection) Active() bool { return s.anchor != s.focus }

// Dragging tells whether the pointer is still selecting.
func (s *TextSelection) Dragging() bool { return s.drag != dragNone }

func (s *TextSelection) Clear() { *s = TextSelection{} }

// Press starts a selection at character off of text id; clicks says single, double or triple, and from to is the word or line it takes.
func (s *TextSelection) Press(id, off, clicks, from, to int, extend bool) {
	switch {
	case clicks >= 2:
		s.origin = [2]selPoint{{id, from}, {id, to}}
		s.anchor, s.focus = s.origin[0], s.origin[1]
		s.drag = dragWords
		if clicks >= 3 {
			s.drag = dragLines
		}
	default:
		if !extend || !s.Active() {
			s.anchor = selPoint{id, off}
		}
		s.focus, s.drag = selPoint{id, off}, dragChars
	}
}

// Drag follows the pointer to character off of text id; from to is the word or line around it, used after a double or triple click.
func (s *TextSelection) Drag(id, off, from, to int) {
	switch s.drag {
	case dragChars:
		s.focus = selPoint{id, off}
	case dragWords, dragLines:
		if (selPoint{id, off}).before(s.origin[0]) {
			s.focus, s.anchor = selPoint{id, from}, s.origin[1]
		} else {
			s.focus, s.anchor = selPoint{id, to}, s.origin[0]
		}
	}
}

func (s *TextSelection) Release() { s.drag = dragNone }

// Mode says whether a double or triple click is being dragged, so the caller knows whether to ask for a word or line.
func (s *TextSelection) Mode() (words, lines bool) { return s.drag == dragWords, s.drag == dragLines }

// All selects from the start of the text first to the end of the text last, whose length is lastLen.
func (s *TextSelection) All(first, last, lastLen int) {
	s.anchor, s.focus, s.drag = selPoint{first, 0}, selPoint{last, lastLen}, dragNone
}

// Range is the part of text id, of length n, that is selected.
func (s *TextSelection) Range(id, n int) (from, to int) {
	start, end := s.anchor, s.focus
	if end.before(start) {
		start, end = end, start
	}
	if id < start.id || id > end.id || start == end {
		return 0, 0
	}
	from, to = 0, n
	if id == start.id {
		from = min(start.off, n)
	}
	if id == end.id {
		to = min(end.off, n)
	}
	return from, to
}

// Bounds are the ids of the first and last text the selection touches.
func (s *TextSelection) Bounds() (first, last int) {
	if s.focus.before(s.anchor) {
		return s.focus.id, s.anchor.id
	}
	return s.anchor.id, s.focus.id
}
