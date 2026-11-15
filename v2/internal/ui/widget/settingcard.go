package widget

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
)

const (
	cardPadY       = 14.4
	cardPadX       = 16
	cardRadius     = 10
	cardMargin     = 12.8
	cardHeadHeight = 28.8
	cardHeadGap    = 12
	cardTitleSize  = 14.4
	cardTitleLine  = cardTitleSize * 1.5
	noteSize       = 13.6
	noteLine       = noteSize * 1.45
	noteTop        = 0
	noteBottom     = 11.2
	toggleGap      = 16
	toggleHintGap  = 2.4
	toggleHintSize = 12.48
	toggleHintLine = toggleHintSize * 1.4
	pageTitleSize  = 18.4
	pageTitleLine  = pageTitleSize * 1.5
	pageTitleGap   = 14.4
	pillMinWidth   = 54.5
	pillPadX       = 8.8
	pillPadY       = 2.4
	pillSize       = 12.48
	pillAlpha      = 0.16
)

var (
	cardTitleStyle = paint.TextStyle{Size: cardTitleSize, Weight: paint.Semibold}
	noteStyle      = paint.TextStyle{Size: noteSize, Weight: paint.Regular}
	hintStyle      = paint.TextStyle{Size: toggleHintSize, Weight: paint.Regular}
	pillStyle      = paint.TextStyle{Size: pillSize, Weight: paint.Semibold}
)

// PageTitle is the heading at the top of a settings page.
func PageTitle(content string) Component {
	title := &Text{Content: content, Style: paint.TextStyle{Size: pageTitleSize, Weight: paint.Semibold}, LineHeight: pageTitleLine, Tone: ToneText}
	return Padded{Bottom: pageTitleGap, Child: title}
}

// SettingNote is the quiet paragraph under a setting's title.
type SettingNote struct {
	Content string
	// Error sets the note in the warning colour, for what went wrong.
	Error bool
	// Bold is for a status that should read before the paragraphs around it.
	Bold bool
}

func (n SettingNote) text() *Text {
	style := noteStyle
	if n.Bold {
		style.Weight = paint.Semibold
	}
	return &Text{Content: n.Content, Style: style, LineHeight: noteLine, Tone: n.tone(), Wrap: true}
}

func (n SettingNote) tone() Tone {
	if n.Error {
		return ToneDangerSoft
	}
	return ToneMuted
}

func (n SettingNote) Measure(c *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: noteTop + n.text().Measure(c, maxWidth).H + noteBottom}
}

func (n SettingNote) Draw(c *Context, r geom.Rect) {
	n.text().Draw(c, geom.Rect{X: r.X, Y: r.Y + noteTop, W: r.W, H: r.H - noteTop - noteBottom})
}

// SettingCard is one setting and everything about it: a title with its tools on the right, then the rest below.
type SettingCard struct {
	Title    string
	Tools    Component
	Children []Component
}

func (k *SettingCard) inner(c *Context, width float32) float32 {
	return width - 2*(cardPadX+c.Hairline())
}

func (k *SettingCard) head(c *Context, width float32) float32 {
	if k.Title == "" && k.Tools == nil {
		return 0
	}
	height := float32(cardHeadHeight)
	if k.Tools != nil {
		height = max(height, k.Tools.Measure(c, width).H)
	}
	return height
}

func (k *SettingCard) bodyHeight(c *Context, width float32) float32 {
	total := k.head(c, width)
	for i, child := range k.Children {
		h := child.Measure(c, width).H
		if _, note := child.(SettingNote); note && i == len(k.Children)-1 {
			h -= noteBottom
		}
		total += h
	}
	return total
}

func (k *SettingCard) Measure(c *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: k.bodyHeight(c, k.inner(c, maxWidth)) + 2*(cardPadY+c.Hairline()) + cardMargin}
}

func (k *SettingCard) Draw(c *Context, r geom.Rect) {
	r.H -= cardMargin
	c.Paint.Fill(r, cardRadius, c.Theme.Surface)
	c.Paint.Stroke(r, cardRadius, c.Hairline(), c.Theme.Border)
	inner := geom.Rect{X: r.X + c.Hairline() + cardPadX, Y: r.Y + c.Hairline() + cardPadY, W: k.inner(c, r.W), H: r.H}
	y := inner.Y
	if head := k.head(c, inner.W); head > 0 {
		if k.Tools != nil {
			size := k.Tools.Measure(c, inner.W)
			k.Tools.Draw(c, geom.Rect{X: inner.Right() - size.W, Y: y + (head-size.H)/2, W: size.W, H: size.H})
		}
		c.Paint.Text(k.Title, inner.X, y+(head-cardTitleLine)/2, cardTitleLine, cardTitleStyle, c.Theme.Text)
		y += head
	}
	for _, child := range k.Children {
		h := child.Measure(c, inner.W).H
		child.Draw(c, geom.Rect{X: inner.X, Y: y, W: inner.W, H: h})
		y += h
	}
}

// ToggleRow is a title and its hint with a switch on the right; the whole row is the target.
type ToggleRow struct {
	Title  string
	Hint   string
	Switch *Switch
	// Dim shows an option that is not available while another one is on: it is there, and it cannot be switched.
	Dim bool
	// Status is a line of its own under the hint: how the thing behind the switch is doing.
	Status      string
	StatusError bool
	// Flat sets the title as plain body text, as on the Server dialog's pages, where the rows are not in a card.
	Flat bool
}

const toggleDimOpacity = 0.5

const (
	flatTitleSize = 14
	flatTitleLine = flatTitleSize * 1.5
)

var flatTitleStyle = paint.TextStyle{Size: flatTitleSize, Weight: paint.Regular}

func (t ToggleRow) title() (paint.TextStyle, float32) {
	if t.Flat {
		return flatTitleStyle, flatTitleLine
	}
	return cardTitleStyle, cardTitleLine
}

func (t ToggleRow) hint() *Text {
	return &Text{Content: t.Hint, Style: hintStyle, LineHeight: toggleHintLine, Tone: ToneMuted, Wrap: true}
}

func (t ToggleRow) Measure(c *Context, maxWidth float32) geom.Size {
	_, line := t.title()
	text := line
	if t.Hint != "" {
		text += toggleHintGap + t.hint().Measure(c, maxWidth-switchWidth-toggleGap).H
	}
	if t.Status != "" {
		text += toggleHintGap + t.status().Measure(c, maxWidth-switchWidth-toggleGap).H
	}
	return geom.Size{W: maxWidth, H: max(text, switchHeight)}
}

func (t ToggleRow) status() *Text {
	tone := ToneMuted
	if t.StatusError {
		tone = ToneWarn
	}
	return &Text{Content: t.Status, Style: hintStyle, LineHeight: toggleHintLine, Tone: tone, Wrap: true}
}

func (t ToggleRow) Draw(c *Context, r geom.Rect) {
	t.Switch.Disabled = t.Dim
	if !t.Dim && c.Hovered(r) {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	if !t.Dim && c.Clicked(r) {
		c.Claim()
		t.Switch.Toggle()
	}
	title := c.Theme.Text
	if t.Dim {
		title = withOpacity(title, toggleDimOpacity)
	}
	style, line := t.title()
	c.Paint.Text(t.Title, r.X, r.Y, line, style, title)
	textWidth := r.W - switchWidth - toggleGap
	y := r.Y + line + toggleHintGap
	if t.Hint != "" {
		hint := t.hint()
		if t.Dim {
			hint.Opacity = toggleDimOpacity
		}
		hint.Draw(c, geom.Rect{X: r.X, Y: y, W: textWidth, H: r.H})
		y += hint.Measure(c, textWidth).H + toggleHintGap
	}
	if t.Status != "" {
		t.status().Draw(c, geom.Rect{X: r.X, Y: y, W: textWidth, H: r.H})
	}
	t.Switch.paint(c, geom.Rect{X: r.Right() - switchWidth, Y: r.Y + (r.H-switchHeight)/2, W: switchWidth, H: switchHeight})
}

// ValuePill is the number beside a slider, set as a chip so it reads as a value and not as a caption.
type ValuePill struct{ Content string }

func (p ValuePill) Measure(c *Context, _ float32) geom.Size {
	width := max(pillMinWidth, c.Paint.TextWidth(p.Content, pillStyle)+2*pillPadX)
	return geom.Size{W: width, H: pillSize*1.5 + 2*pillPadY}
}

func (p ValuePill) Draw(c *Context, r geom.Rect) {
	c.Paint.Fill(r, r.H/2, withOpacity(c.Theme.Accent, pillAlpha))
	width := c.Paint.TextWidth(p.Content, pillStyle)
	c.Paint.Text(p.Content, r.X+(r.W-width)/2, r.Y+pillPadY, pillSize*1.5, pillStyle, c.Theme.Accent)
}

const toggleListPad = 8

// ToggleList stacks toggles inside one card, a rule between them.
type ToggleList []ToggleRow

func (l ToggleList) pad(i int) (top, bottom float32) {
	if i > 0 {
		top = toggleListPad
	}
	if i < len(l)-1 {
		bottom = toggleListPad
	}
	return top, bottom
}

func (l ToggleList) Measure(c *Context, maxWidth float32) geom.Size {
	height := float32(0)
	for i, row := range l {
		top, bottom := l.pad(i)
		height += top + bottom + row.Measure(c, maxWidth).H
		if i > 0 {
			height += c.Hairline()
		}
	}
	return geom.Size{W: maxWidth, H: height}
}

func (l ToggleList) Draw(c *Context, r geom.Rect) {
	y := r.Y
	for i, row := range l {
		top, bottom := l.pad(i)
		if i > 0 {
			c.Paint.Fill(geom.Rect{X: r.X, Y: y, W: r.W, H: c.Hairline()}, 0, c.Theme.Border)
			y += c.Hairline()
		}
		y += top
		h := row.Measure(c, r.W).H
		row.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: h})
		y += h + bottom
	}
}

const (
	rangeGapTop = 6
	rangeTrack  = 6
)

// RangeRow is a slider as it sits under a setting's title: the track alone is as tall as the row, the thumb overhangs.
// More below it wants a gap of RangeAfter.
type RangeRow struct{ Slider *Slider }

func (r RangeRow) Measure(_ *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: rangeGapTop + rangeTrack}
}

func (r RangeRow) Draw(c *Context, area geom.Rect) {
	box := r.Slider.Measure(c, area.W).H
	r.Slider.Draw(c, geom.Rect{X: area.X, Y: area.Y + rangeGapTop + rangeTrack/2 - box/2, W: area.W, H: box})
}

// RangeAfter is the gap under a RangeRow that has something below it.
const RangeAfter = 16
