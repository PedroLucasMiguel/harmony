package widget

import (
	"strings"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/emojitext"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	areaTextSize = 14
	areaLine     = 22
	areaPadY     = 8
	areaPadX     = 5.6
	areaMaxLines = 8
	areaCaretW   = 1
)

var areaStyle = paint.TextStyle{Size: areaTextSize, Weight: paint.Regular}

type areaLineSpan struct {
	from, to int
	text     string
}

// TextArea is a box for writing several lines: it wraps, grows with what is in it up to eight lines, and scrolls after that.
// Enter calls OnSubmit; Shift+Enter starts a new line.
type TextArea struct {
	Placeholder string
	OnSubmit    func()
	OnChange    func()
	// OnPaste sees the clipboard's text (empty when it holds none) before it is put in, and returns true when it took the paste itself.
	OnPaste   func(text string) bool
	MaxLength int

	value     []rune
	text      string
	ed        textEdit
	focus     Focus
	want      bool
	scroll    float32
	wrapped   []areaLineSpan
	ends      []int
	wrapWidth float32
	dirty     bool
	caretAt   caretMemo
	nav       navigation
	navC      *Context
}

// caretMemo is where the caret was drawn for a text, so a blinking caret asks the font only when something moved it.
type caretMemo struct {
	text        string
	caret, from int
	x           float32
	ok          bool
}

func (a *TextArea) Value() string { return a.text }

// Runes is the text as characters, to be read and not changed.
func (a *TextArea) Runes() []rune { return a.value }

// Caret is the caret's place as a character index.
func (a *TextArea) Caret() int { return a.ed.caret }

// SelectedRunes is the selected characters, to be read and not changed.
func (a *TextArea) SelectedRunes() []rune { return a.ed.selected(a.value) }

// SelectedLength is how many characters are selected.
func (a *TextArea) SelectedLength() int {
	from, to := a.ed.span()
	return to - from
}

func (a *TextArea) SetValue(s string) {
	a.value = []rune(s)
	a.text = s
	a.ed.place(len(a.value))
	a.ed.reset()
	a.dirty = true
}

func (a *TextArea) Clear() { a.SetValue("") }

// Insert puts text at the caret, in place of what is selected.
func (a *TextArea) Insert(text string) {
	from, to := a.ed.span()
	a.put(from, to, []rune(text), editOther)
}

// Replace puts text in place of the characters from to, and the caret after it.
func (a *TextArea) Replace(from, to int, text string) {
	a.put(min(from, len(a.value)), min(to, len(a.value)), []rune(text), editOther)
}

func (a *TextArea) put(from, to int, with []rune, kind editKind) {
	out := a.ed.replace(a.value, from, to, with, kind, a.MaxLength)
	a.apply(out)
}

func (a *TextArea) apply(out []rune) {
	if sameRunes(out, a.value) {
		return
	}
	a.value, a.text, a.dirty = out, string(out), true
	if a.OnChange != nil {
		a.OnChange()
	}
}

func (a *TextArea) RequestFocus() { a.want = true }

func (a *TextArea) Focused(c *Context) bool { return c.Focused(&a.focus) }

func (a *TextArea) wrap(c *Context, width float32) {
	if !a.dirty && width == a.wrapWidth {
		return
	}
	a.dirty, a.wrapWidth = false, width
	a.wrapped = a.wrapped[:0]
	start := 0
	for start <= len(a.value) {
		end := start
		for end < len(a.value) && a.value[end] != '\n' {
			end++
		}
		a.wrapParagraph(c, start, end, width)
		start = end + 1
	}
}

func (a *TextArea) wrapParagraph(c *Context, from, to int, width float32) {
	if from == to {
		a.wrapped = append(a.wrapped, areaLineSpan{from: from, to: from})
		return
	}
	base := from
	a.ends = emojitext.ClusterEnds(a.ends[:0], a.value[from:to])
	k := 0
	for from < to {
		end, lastSpace := from, -1
		for ; k < len(a.ends); k++ {
			next := base + a.ends[k]
			if c.Paint.TextWidth(string(a.value[from:next]), areaStyle) > width && end > from {
				break
			}
			if a.value[next-1] == ' ' {
				lastSpace = next - 1
			}
			end = next
		}
		next := end
		if end < to && lastSpace > from {
			end, next = lastSpace+1, lastSpace+1
			for k > 0 && base+a.ends[k-1] > next {
				k--
			}
		}
		a.wrapped = append(a.wrapped, areaLineSpan{from: from, to: end, text: string(a.value[from:end])})
		from = next
	}
}

func (a *TextArea) lineOf(index int) int {
	for i := len(a.wrapped) - 1; i >= 0; i-- {
		if index >= a.wrapped[i].from {
			return i
		}
	}
	return 0
}

func (a *TextArea) Measure(c *Context, maxWidth float32) geom.Size {
	a.wrap(c, maxWidth-2*areaPadX)
	lines := min(max(len(a.wrapped), 1), areaMaxLines)
	return geom.Size{W: maxWidth, H: float32(lines)*areaLine + 2*areaPadY}
}

func (a *TextArea) Draw(c *Context, r geom.Rect) {
	c.Register(&a.focus)
	if a.want {
		c.Focus(&a.focus)
		a.want = false
	}
	inner := geom.Rect{X: r.X + areaPadX, Y: r.Y + areaPadY, W: r.W - 2*areaPadX, H: r.H - 2*areaPadY}
	a.wrap(c, inner.W)
	if c.Hovered(r) {
		c.SetCursor(rl.MouseCursorIBeam)
		if c.In.Wheel != 0 {
			a.scroll -= c.In.Wheel * areaLine
		}
	}
	if c.Clicked(r) {
		c.Claim()
		c.Focus(&a.focus)
		a.ed.clamp(len(a.value))
		a.ed.press(c.In.Clicks, a.indexAt(c, c.In.MouseX-inner.X, c.In.MouseY-inner.Y+a.scroll), c.In.Shift, a.value, a.navigation(c))
	}
	if a.ed.drag != dragNone {
		if c.In.Down {
			a.ed.dragOver(a.indexAt(c, c.In.MouseX-inner.X, c.In.MouseY-inner.Y+a.scroll), a.value, a.navigation(c))
		} else {
			a.ed.drag = dragNone
		}
	}
	focused := c.Focused(&a.focus)
	if focused {
		a.edit(c)
		a.wrap(c, inner.W)
	}
	a.ed.clamp(len(a.value))
	total := float32(len(a.wrapped)) * areaLine
	caretLine := a.lineOf(a.ed.caret)
	if focused {
		a.scroll = min(max(a.scroll, float32(caretLine+1)*areaLine-inner.H), float32(caretLine)*areaLine)
	}
	a.scroll = min(max(a.scroll, 0), max(0, total-inner.H))

	c.Paint.PushClip(inner)
	selected := focused && a.ed.hasSelection()
	first := int(a.scroll / areaLine)
	for i := first; i < len(a.wrapped) && float32(i)*areaLine-a.scroll < inner.H; i++ {
		line := a.wrapped[i]
		y := inner.Y + float32(i)*areaLine - a.scroll
		if selected {
			a.drawSelection(c, line, inner.X, y)
		}
		c.Paint.Text(line.text, inner.X, y, areaLine, areaStyle, c.Theme.Text)
	}
	if len(a.value) == 0 {
		c.Paint.Text(a.Placeholder, inner.X, inner.Y, areaLine, areaStyle, theme.WithAlpha(c.Theme.Muted, 1))
	}
	if focused && !selected && c.Blink() {
		line := a.wrapped[caretLine]
		m := &a.caretAt
		if !m.ok || m.text != a.text || m.caret != a.ed.caret || m.from != line.from {
			*m = caretMemo{a.text, a.ed.caret, line.from, c.Paint.TextWidth(string(a.value[line.from:min(a.ed.caret, line.to)]), areaStyle), true}
		}
		x := inner.X + m.x
		c.Paint.Fill(geom.Rect{X: x, Y: inner.Y + float32(caretLine)*areaLine - a.scroll + 2, W: areaCaretW, H: areaLine - 4}, 0, c.Theme.Text)
	}
	c.Paint.PopClip()
}

func (a *TextArea) drawSelection(c *Context, line areaLineSpan, x, y float32) {
	from, to := a.ed.span()
	if to < line.from || from > line.to || from == to {
		return
	}
	left := max(from, line.from)
	right := min(to, line.to)
	if left > right || left == right && !(to > line.to && from <= line.to) {
		return
	}
	x0 := c.Paint.TextWidth(string(a.value[line.from:left]), areaStyle)
	x1 := x0 + c.Paint.TextWidth(string(a.value[left:right]), areaStyle)
	if to > line.to && (line.to == len(a.value) || a.value[line.to] == '\n') {
		x1 += c.Paint.TextWidth(" ", areaStyle)
	}
	c.Paint.Fill(geom.Rect{X: x + x0, Y: y, W: x1 - x0, H: areaLine}, 0, selectionColor(c))
}

func (a *TextArea) indexAt(c *Context, x, y float32) int {
	line := a.wrapped[min(max(int(y/areaLine), 0), len(a.wrapped)-1)]
	for from := line.from; from < line.to; {
		next := emojitext.NextCluster(a.value[:line.to], from)
		mid := (c.Paint.TextWidth(string(a.value[line.from:from]), areaStyle) + c.Paint.TextWidth(string(a.value[line.from:next]), areaStyle)) / 2
		if x < mid {
			return from
		}
		from = next
	}
	return a.lineEnd(line)
}

// lineEnd is where the caret goes at the end of a line: before the space a soft break leaves at its end.
func (a *TextArea) lineEnd(line areaLineSpan) int {
	if line.to > line.from && line.to < len(a.value) && a.value[line.to] != '\n' && a.value[line.to-1] == ' ' {
		return line.to - 1
	}
	return line.to
}

func (a *TextArea) navigation(c *Context) navigation {
	if a.navC != c {
		a.navC = c
		a.nav = navigation{
			paragraph: true,
			lineStart: func(i int) int { return a.wrapped[a.lineOf(i)].from },
			lineEnd:   func(i int) int { return a.lineEnd(a.wrapped[a.lineOf(i)]) },
			vertical: func(i int, down bool) int {
				line := a.lineOf(i)
				target := line - 1
				if down {
					target = line + 1
				}
				if target < 0 || target >= len(a.wrapped) {
					return i
				}
				x := c.Paint.TextWidth(string(a.value[a.wrapped[line].from:i]), areaStyle)
				return a.indexAt(c, x, float32(target)*areaLine)
			},
		}
	}
	return a.nav
}

func (a *TextArea) edit(c *Context) {
	in := c.In
	if editing(in) {
		out, _ := a.ed.keys(in, a.value, a.navigation(c), a.MaxLength, false, a.clipboard, rl.SetClipboardText)
		a.apply(out)
	}
	if in.Enter && !in.Shift && a.OnSubmit != nil {
		a.OnSubmit()
	}
}

func (a *TextArea) clipboard() string {
	text := strings.ReplaceAll(strings.ReplaceAll(rl.GetClipboardText(), "\r\n", "\n"), "\r", "\n")
	if a.OnPaste != nil && a.OnPaste(text) {
		return ""
	}
	return text
}
