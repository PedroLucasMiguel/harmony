package widget

import (
	"image/color"
	"strings"
	"unicode/utf8"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/emojitext"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	fieldPaddingY    = 10
	compactPadY      = 8
	fieldPaddingX    = 12
	fieldRadius      = 8
	fieldTextSize    = 14
	fieldLineHeight  = fieldTextSize * 1.5
	placeholderAlpha = 0.4
)

const (
	insetPadY      = 5.6
	insetPadX      = 7.2
	insetRadius    = 6
	insetEdgeAlpha = 0.16
	boxPadY        = 5.58
	boxPadLeft     = 27.2
	boxPadRight    = 25.6
	boxIconX       = 9.6
	boxIconSize    = 16.3
	boxIconAlpha   = 0.55
	searchTextSize = 13.6
	searchLine     = searchTextSize * 1.5
	searchPadY     = 6.4
	searchPadLeft  = 30.4
	searchPadRight = 9.6
	searchIconX    = 8.8
	searchIconSize = 13.6
	searchRing     = 2
	searchRingA    = 0.25
)

var fieldStyle = paint.TextStyle{Size: fieldTextSize, Weight: paint.Regular}
var searchStyle = paint.TextStyle{Size: searchTextSize, Weight: paint.Regular}

func (f *TextField) style() paint.TextStyle {
	if f.Style.Size > 0 {
		return f.Style
	}
	if f.Search || f.Box {
		return searchStyle
	}
	return fieldStyle
}

func (f *TextField) lineHeight() float32 {
	if f.Style.Size > 0 {
		return f.Style.Size * 1.5
	}
	if f.Search || f.Box {
		return searchLine
	}
	return fieldLineHeight
}

// padding is the space between the border and the text: top and bottom, left, right.
func (f *TextField) padding() (y, left, right float32) {
	if f.Bare {
		return 0, 0, 0
	}
	if f.Box {
		return boxPadY, boxPadLeft + f.Lead, boxPadRight
	}
	if f.Inset {
		return insetPadY, insetPadX, insetPadX
	}
	if f.Search {
		return searchPadY, searchPadLeft, searchPadRight
	}
	if f.Compact {
		return compactPadY, fieldPaddingX, fieldPaddingX
	}
	return fieldPaddingY, fieldPaddingX, fieldPaddingX
}

type TextField struct {
	Value       string
	Placeholder string
	Password    bool
	Invalid     bool
	Search      bool
	// Box is the search look of a list's own filter: the magnifier is a solid glyph, the box a little shorter.
	Box bool
	// Lead is room kept before the text in a Box, for what the screen draws there (the chips of a search).
	Lead float32
	// Bare is the text alone, for a field that sits in a box the screen draws; Style, when it has a size, is the font it is written in.
	Bare  bool
	Style paint.TextStyle
	// Inset is the field inside a dialog: a darker well with a lighter edge.
	Inset bool
	// Compact is the plain field a little shorter, for a list's own filter.
	Compact   bool
	MaxLength int
	OnEnter   func()

	focus     Focus
	wantFocus bool
	ed        textEdit
	scroll    float32
	masked    string
	maskedLen int
}

func (f *TextField) RequestFocus() { f.wantFocus = true }

func (f *TextField) Measure(c *Context, maxWidth float32) geom.Size {
	y, _, _ := f.padding()
	return geom.Size{W: maxWidth, H: 2*y + f.lineHeight() + 2*c.Hairline()}
}

func (f *TextField) Draw(c *Context, r geom.Rect) {
	c.Register(&f.focus)
	if f.wantFocus {
		c.Focus(&f.focus)
		f.wantFocus = false
	}
	padY, padLeft, padRight := f.padding()
	inner := r.InsetAll(c.Hairline()).Inset(padLeft, padY, padRight, padY)
	if c.Hovered(r) {
		c.SetCursor(rl.MouseCursorIBeam)
	}
	if c.Clicked(r) {
		c.Claim()
		c.Focus(&f.focus)
		f.ed.press(c.In.Clicks, f.caretAt(c, c.In.MouseX-inner.X+f.scroll), c.In.Shift, f.runes(), navigation{})
	}
	if f.ed.drag != dragNone {
		if c.In.Down {
			f.ed.dragOver(f.caretAt(c, c.In.MouseX-inner.X+f.scroll), f.runes(), navigation{})
		} else {
			f.ed.drag = dragNone
		}
	}
	focused := c.Focused(&f.focus)
	if focused {
		f.edit(c)
	}

	border := c.Theme.Border
	switch {
	case focused:
		border = c.Theme.Accent
	case f.Invalid:
		border = c.Theme.Danger
	}
	f.drawBox(c, r, border, focused)

	c.Paint.PushClip(inner)
	f.drawText(c, inner, focused)
	c.Paint.PopClip()
}

func (f *TextField) drawBox(c *Context, r geom.Rect, border color.RGBA, focused bool) {
	if f.Bare {
		return
	}
	if f.Inset {
		if !f.Invalid {
			border = theme.WithAlpha(c.Theme.Tint, insetEdgeAlpha)
		}
		c.Paint.Fill(r, insetRadius, c.Theme.Bg)
		c.Paint.Stroke(r, insetRadius, c.Hairline(), border)
		return
	}
	if !f.Search && !f.Box {
		c.Paint.Fill(r, fieldRadius, c.Theme.Surface2)
		c.Paint.Stroke(r, fieldRadius, c.Hairline(), border)
		return
	}
	radius := r.H / 2
	if focused && !f.Box {
		c.Paint.Stroke(r.InsetAll(-searchRing/2), radius+searchRing/2, searchRing, theme.WithAlpha(c.Theme.Accent, searchRingA))
	}
	c.Paint.Fill(r, radius, c.Theme.Bg)
	c.Paint.Stroke(r, radius, c.Hairline(), border)
	name, x, size, ink := "search-thin", float32(searchIconX), float32(searchIconSize), c.Theme.Muted
	if f.Box {
		name, x, size, ink = "magnifying-glass", boxIconX, boxIconSize, theme.WithAlpha(c.Theme.Text, boxIconAlpha)
	}
	icon := geom.Rect{X: r.X + c.Hairline() + x, Y: r.Y + (r.H-size)/2, W: size, H: size}
	c.Paint.Icon(name, icon, ink)
}

func (f *TextField) runes() []rune { return []rune(f.Value) }

// runePrefix is the first n characters of s, or all of it when it is shorter.
func runePrefix(s string, n int) string {
	for i := range s {
		if n == 0 {
			return s[:i]
		}
		n--
	}
	return s
}

func (f *TextField) shown() string {
	if f.Password {
		if n := utf8.RuneCountInString(f.Value); n != f.maskedLen || f.masked == "" && n > 0 {
			f.masked, f.maskedLen = strings.Repeat("•", n), n
		}
		return f.masked
	}
	return f.Value
}

func (f *TextField) caretAt(c *Context, x float32) int {
	shown := []rune(f.shown())
	for from := 0; from < len(shown); {
		next := emojitext.NextCluster(shown, from)
		mid := (c.Paint.TextWidth(string(shown[:from]), f.style()) + c.Paint.TextWidth(string(shown[:next]), f.style())) / 2
		if x < mid {
			return from
		}
		from = next
	}
	return len(shown)
}

func (f *TextField) edit(c *Context) {
	in := c.In
	if editing(in) {
		out, changed := f.ed.keys(in, f.runes(), navigation{}, f.MaxLength, f.Password, singleLineClipboard, rl.SetClipboardText)
		if changed {
			f.Value = string(out)
		}
	}
	if in.Enter && f.OnEnter != nil {
		f.OnEnter()
	}
}

func singleLineClipboard() string {
	return strings.Join(strings.Fields(rl.GetClipboardText()), " ")
}

func (f *TextField) drawText(c *Context, inner geom.Rect, focused bool) {
	text := f.shown()
	if text == "" {
		c.Paint.Text(f.Placeholder, inner.X, inner.Y, f.lineHeight(), f.style(), f.placeholderColor(c))
	}
	caretX := c.Paint.TextWidth(runePrefix(text, f.ed.caret), f.style())
	f.scroll = min(max(f.scroll, caretX-inner.W+2), caretX)
	x := inner.X - f.scroll
	selected := focused && f.ed.hasSelection() && text != ""
	if selected {
		from, to := f.ed.span()
		left := c.Paint.TextWidth(runePrefix(text, from), f.style())
		right := c.Paint.TextWidth(runePrefix(text, to), f.style())
		c.Paint.Fill(geom.Rect{X: x + left, Y: inner.Y, W: right - left, H: f.lineHeight()}, 0, selectionColor(c))
	}
	c.Paint.Text(text, x, inner.Y, f.lineHeight(), f.style(), c.Theme.Text)
	if focused && !selected && c.Blink() {
		c.Paint.Fill(geom.Rect{X: x + caretX, Y: inner.Y + 1, W: c.Hairline(), H: f.lineHeight() - 2}, 0, c.Theme.Text)
	}
}

func (f *TextField) placeholderColor(c *Context) color.RGBA {
	if f.Search || f.Box || f.Bare {
		return c.Theme.Muted
	}
	return theme.WithAlpha(c.Theme.Text, placeholderAlpha)
}
