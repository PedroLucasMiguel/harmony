package widget

import (
	"image/color"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	promptBackdrop  = 140
	promptMinWidth  = 352
	promptMaxShare  = 0.9
	promptPadX      = 19.2
	promptPadY      = 17.6
	promptRadius    = 10
	promptEdgeAlpha = 0.14
	promptTitleSize = 16
	promptTitleLine = 24
	promptTitleGap  = 4.8
	promptTextSize  = 13.6
	promptTextGap   = 11.2
	promptBodyTop   = 14.4
	promptLabelSize = 12.48
	promptLabelGap  = 3.2
	promptFieldGap  = 9.6
	promptButtonTop = 12.8
	promptButtonGap = 8
	promptLabelDim  = 0.7
)

type PromptField struct {
	Label    string
	Input    TextField
	Required bool
}

// Prompt is a question over the whole window: some words, a field or two, and the buttons that answer it.
type Prompt struct {
	Title    string
	Text     string
	Fields   []*PromptField
	OK       string
	Cancel   string
	OnSubmit func(values []string)
	OnCancel func()
	// Busy dims the OK button and stops it answering while the answer is being checked.
	Busy bool
	// Body is anything else the question holds, under its words; Buttons, when set, are the answers in place of OK and Cancel; Width is a fixed width.
	Body    Component
	Buttons []*Button
	Width   float32

	opened bool
}

func (p *Prompt) textStyle() paint.TextStyle {
	return paint.TextStyle{Size: promptTextSize, Weight: paint.Regular}
}

func (p *Prompt) values() ([]string, bool) {
	values := make([]string, len(p.Fields))
	for i, f := range p.Fields {
		values[i] = f.Input.Value
		if f.Required && f.Input.Value == "" {
			return values, false
		}
	}
	return values, true
}

func (p *Prompt) submit() {
	if p.Busy {
		return
	}
	if values, ok := p.values(); ok && p.OnSubmit != nil {
		p.OnSubmit(values)
	}
}

func (p *Prompt) cancel() {
	if p.OnCancel != nil {
		p.OnCancel()
	}
}

func (p *Prompt) Draw(c *Context, bounds geom.Rect) {
	c.Paint.Fill(bounds, 0, color.RGBA{A: promptBackdrop})
	if !p.opened {
		p.opened = true
		if len(p.Fields) > 0 {
			p.Fields[0].Input.RequestFocus()
		}
	}
	edge := c.Hairline()
	title := &Text{Content: p.Title, Tone: ToneText, Style: paint.TextStyle{Size: promptTitleSize, Weight: paint.Semibold}, LineHeight: promptTitleLine}
	text := &Text{Content: p.Text, Tone: ToneMuted, Wrap: true, Style: p.textStyle(), LineHeight: promptTextSize * 1.5}

	maxWidth := min(bounds.W*promptMaxShare, bounds.W-24)
	contentMax := maxWidth - 2*(promptPadX+edge)
	natural := max(title.Measure(c, contentMax).W, c.Paint.TextWidth(p.Text, p.textStyle()))
	width := min(max(natural+2*(promptPadX+edge), promptMinWidth), maxWidth)
	if p.Width > 0 {
		width = min(p.Width, maxWidth)
	}
	inner := width - 2*(promptPadX+edge)

	buttons := p.buttons()
	height := 2*(promptPadY+edge) + promptTitleLine + promptTitleGap
	if p.Text != "" {
		height += text.Measure(c, inner).H + promptTextGap
	}
	bodyH := float32(0)
	if p.Body != nil {
		bodyH = p.Body.Measure(c, inner).H
		height += promptBodyTop + bodyH
	}
	height += p.fieldsHeight(c, inner)
	height += promptButtonTop + buttons[0].Measure(c, 0).H

	card := geom.Rect{X: bounds.X + (bounds.W-width)/2, Y: bounds.Y + (bounds.H-height)/2, W: width, H: height}
	c.Layer(p)
	if c.EscapeFor(p) {
		c.Claim()
		p.cancel()
		return
	}
	c.Claim()
	c.Paint.Fill(card, promptRadius, c.Theme.Surface2)
	c.Paint.Stroke(card, promptRadius, edge, theme.WithAlpha(c.Theme.Tint, promptEdgeAlpha))

	y := card.Y + promptPadY + edge
	x := card.X + promptPadX + edge
	title.Draw(c, geom.Rect{X: x, Y: y, W: inner, H: promptTitleLine})
	y += promptTitleLine + promptTitleGap
	if p.Text != "" {
		h := text.Measure(c, inner).H
		text.Draw(c, geom.Rect{X: x, Y: y, W: inner, H: h})
		y += h + promptTextGap
	}
	if p.Body != nil {
		y += promptBodyTop
		p.Body.Draw(c, geom.Rect{X: x, Y: y, W: inner, H: bodyH})
		y += bodyH
	}
	y = p.drawFields(c, x, y, inner)
	y += promptButtonTop
	p.drawButtons(c, buttons, geom.Rect{X: x, Y: y, W: inner, H: buttons[0].Measure(c, 0).H})
}

func (p *Prompt) fieldHeight(c *Context) float32 {
	return promptLabelSize*1.5 + promptLabelGap + (&TextField{Inset: true}).Measure(c, 0).H
}

func (p *Prompt) fieldsHeight(c *Context, width float32) float32 {
	if len(p.Fields) == 0 {
		return 0
	}
	return float32(len(p.Fields))*p.fieldHeight(c) + float32(len(p.Fields)-1)*promptFieldGap
}

func (p *Prompt) drawFields(c *Context, x, y, width float32) float32 {
	for i, f := range p.Fields {
		f.Input.Inset = true
		f.Input.OnEnter = p.submit
		label := &Text{
			Content: f.Label, Upper: true, Tone: ToneMuted, Opacity: promptLabelDim,
			Style: paint.TextStyle{Size: promptLabelSize, Weight: paint.Semibold, Spacing: 0.4}, LineHeight: promptLabelSize * 1.5,
		}
		label.Draw(c, geom.Rect{X: x, Y: y, W: width, H: promptLabelSize * 1.5})
		y += promptLabelSize*1.5 + promptLabelGap
		h := f.Input.Measure(c, width).H
		f.Input.Draw(c, geom.Rect{X: x, Y: y, W: width, H: h})
		y += h
		if i < len(p.Fields)-1 {
			y += promptFieldGap
		}
	}
	return y
}

func (p *Prompt) buttons() []*Button {
	if p.Buttons != nil {
		return p.Buttons
	}
	ok := &Button{Label: p.OK, Variant: Primary, Disabled: p.Busy, OnClick: p.submit}
	if p.Cancel == "" {
		return []*Button{ok}
	}
	return []*Button{{Label: p.Cancel, Variant: Ghost, OnClick: p.cancel}, ok}
}

func (p *Prompt) drawButtons(c *Context, buttons []*Button, row geom.Rect) {
	x := row.Right()
	for i := len(buttons) - 1; i >= 0; i-- {
		size := buttons[i].Measure(c, 0)
		x -= size.W
		buttons[i].Draw(c, geom.Rect{X: x, Y: row.Y, W: size.W, H: size.H})
		x -= promptButtonGap
	}
}
