package poll

import (
	"image/color"
	"os"
	"path/filepath"
	"strings"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/chat"
	"harmony/v2/internal/filedialog"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	labelSize     = 12.48
	labelLine     = 18.72
	labelGap      = 3.2
	labelDim      = 0.7
	fieldGap      = 9.6
	sectionTop    = 12.8
	sectionGap    = 6.4
	optionRowGap  = 6.4
	optionsBottom = 11.2
	dropSize      = 30.4
	dropIcon      = 16
	areaLines     = 2
	areaRadius    = 6
	areaFill      = 0.16
	pictureGap    = 9.6
	previewW      = 128
	previewH      = 80
	switchRow     = 24.4
	switchText    = 13
	switchLine    = 19.5
	switchGap     = 10
	switchMargin  = 8
	endsIndent    = 54.4
	endsWidth     = 189.3
	endsHeight    = 35.9
	endsBottom    = 6.4
	problemHeight = 16.3
	problemGap    = 12.8
	endsLayout    = "2006-01-02 15:04"
	endsDefault   = 24 * time.Hour
)

var (
	labelStyle   = paint.TextStyle{Size: labelSize, Weight: paint.Semibold, Spacing: 0.4}
	sectionStyle = paint.TextStyle{Size: labelSize, Weight: paint.Semibold}
	countStyle   = paint.TextStyle{Size: labelSize, Weight: paint.Regular}
	switchStyle  = paint.TextStyle{Size: switchText, Weight: paint.Regular}
)

type optionRow struct {
	field widget.TextField
	drop  widget.GlyphButton
}

// Dialog is where a poll is made: the question, the options and what else it takes; OnSend is given the poll and the path of its picture, if it has one.
type Dialog struct {
	OnSend func(draft hclient.PollDraft, picture string)

	title, footer widget.TextField
	description   widget.TextArea
	rows          []*optionRow
	multiple      widget.Switch
	anonymous     widget.Switch
	timed         widget.Switch
	ends          widget.TextField
	pick, remove  widget.Button
	cancel, send  widget.Button
	scroll        widget.Scroll

	picture  string
	fetch    func() ([]byte, error)
	picking  bool
	dropping *optionRow
	problem  chat.PollProblem
}

// Open shows the dialog over the window.
func Open(c *widget.Context, onSend func(draft hclient.PollDraft, picture string)) {
	d := &Dialog{OnSend: onSend}
	for _, f := range []*widget.TextField{&d.title, &d.footer, &d.ends} {
		f.Inset = true
	}
	d.title.MaxLength, d.footer.MaxLength = chat.PollTitleMax, chat.PollFooterMax
	d.description.MaxLength = chat.PollDescriptionMax
	d.pick = widget.Button{Variant: widget.Ghost, Small: true}
	d.remove = widget.Button{Variant: widget.Ghost, Small: true}
	d.cancel = widget.Button{Variant: widget.Ghost, OnClick: c.CloseModal}
	d.send = widget.Button{Variant: widget.Primary, OnClick: func() { d.submit(c) }}
	d.timed.OnChange = func(on bool) {
		if on && d.ends.Value == "" {
			d.ends.Value = time.Now().Add(endsDefault).Format(endsLayout)
		}
	}
	d.pick.OnClick = func() { d.choosePicture(c) }
	d.remove.OnClick = func() { d.picture, d.fetch = "", nil }
	d.addRow()
	d.addRow()
	d.title.RequestFocus()
	d.scroll.Child, d.scroll.Bar = &dialogBody{d: d}, true
	c.OpenModal(d)
}

func (d *Dialog) addRow() {
	row := &optionRow{}
	row.field = widget.TextField{Inset: true, MaxLength: chat.PollOptionMax}
	row.field.OnEnter = func() {
		for i, r := range d.rows {
			if r == row && i+1 < len(d.rows) {
				d.rows[i+1].field.RequestFocus()
			}
		}
	}
	row.drop = widget.GlyphButton{Icon: "x", Faint: true, Size: dropIcon, PadX: (dropSize - dropIcon) / 2, PadY: (dropSize - dropIcon) / 2, OnClick: func() { d.dropping = row }}
	d.rows = append(d.rows, row)
}

func (d *Dialog) form() chat.PollForm {
	f := chat.PollForm{
		Title: d.title.Value, Description: d.description.Value(), Footer: d.footer.Value,
		Multiple: d.multiple.On, Anonymous: d.anonymous.On,
	}
	for _, r := range d.rows {
		f.Options = append(f.Options, r.field.Value)
	}
	if d.timed.On {
		if t, err := time.ParseInLocation(endsLayout, strings.TrimSpace(d.ends.Value), time.Local); err != nil {
			f.EndsBad = true
		} else {
			f.EndsAt = t.UnixMilli()
		}
	}
	return f
}

func (d *Dialog) submit(c *widget.Context) {
	draft, problem := chat.CleanPoll(d.form(), time.Now())
	if problem != chat.PollOK {
		return
	}
	c.CloseModal()
	if d.OnSend != nil {
		d.OnSend(draft, d.picture)
	}
}

func (d *Dialog) choosePicture(c *widget.Context) {
	if d.picking {
		return
	}
	d.picking = true
	title := c.T("poll.add_picture")
	go func() {
		files := filedialog.Pick(title)
		c.Post(func() {
			d.picking = false
			for _, f := range files {
				if isPicture(f) {
					d.picture = f
					d.fetch = func() ([]byte, error) { return os.ReadFile(f) }
					return
				}
			}
		})
	}()
}

func isPicture(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp":
		return true
	}
	return false
}

func (d *Dialog) Draw(c *widget.Context, bounds geom.Rect) {
	c.Paint.Fill(bounds, 0, color.RGBA{A: backdropAlpha})
	c.Layer(d)
	if c.EscapeFor(d) {
		c.Claim()
		c.CloseModal()
		return
	}
	c.Claim()
	_, d.problem = chat.CleanPoll(d.form(), time.Now())
	d.send.Disabled = d.problem != chat.PollOK
	card := dialogCard(c, bounds, d.scroll.Child.Measure(c, min(dialogWidth, bounds.W*dialogShare)-2*c.Hairline()).H)
	paintCard(c, card)
	d.scroll.Draw(c, card.InsetAll(c.Hairline()))
	d.settle()
}

// settle applies what a click asked for after the frame has been drawn: a removed option, and an empty one to write in.
func (d *Dialog) settle() {
	if r := d.dropping; r != nil {
		d.dropping = nil
		for i, o := range d.rows {
			if o == r {
				d.rows = append(d.rows[:i:i], d.rows[i+1:]...)
				break
			}
		}
	}
	if last := d.rows[len(d.rows)-1]; len(d.rows) < chat.PollMaxOptions && strings.TrimSpace(last.field.Value) != "" {
		d.addRow()
	}
}

type dialogBody struct{ d *Dialog }

func (b *dialogBody) Measure(c *widget.Context, w float32) geom.Size {
	return geom.Size{W: w, H: b.d.walk(c, geom.Rect{W: w}, false)}
}

func (b *dialogBody) Draw(c *widget.Context, r geom.Rect) { b.d.walk(c, r, true) }

func (d *Dialog) label(c *widget.Context, draw bool, text string, x, y, w float32) float32 {
	if draw {
		upper := strings.ToUpper(text)
		c.Paint.Text(upper, x, y, labelLine, labelStyle, theme.WithAlpha(c.Theme.Muted, labelDim))
	}
	return labelLine + labelGap
}

func (d *Dialog) field(c *widget.Context, draw bool, text string, f *widget.TextField, x, y, w float32) float32 {
	top := d.label(c, draw, text, x, y, w)
	h := f.Measure(c, w).H
	if draw {
		f.Draw(c, geom.Rect{X: x, Y: y + top, W: w, H: h})
	}
	return top + h + fieldGap
}

// walk lays the dialog out from the top of r, drawing it when draw is set, and returns its height.
func (d *Dialog) walk(c *widget.Context, r geom.Rect, draw bool) float32 {
	edge := c.Hairline()
	x, w := r.X+dialogPadX, r.W-2*dialogPadX
	y := r.Y + dialogPadY
	if draw {
		c.Paint.Text(c.T("poll.create"), x, y, dialogHeadLine, dialogTitleStyle, c.Theme.Text)
	}
	y += dialogHeadLine + dialogHeadGap

	d.title.Placeholder = c.T("poll.question_placeholder")
	y += d.field(c, draw, c.T("poll.question"), &d.title, x, y, w)

	d.description.Placeholder = c.T("poll.description_placeholder")
	y += d.label(c, draw, c.T("poll.description"), x, y, w)
	areaH := areaLines*bodyLine + 2*insetPad + 2*edge
	if draw {
		d.drawArea(c, geom.Rect{X: x, Y: y, W: w, H: areaH})
	}
	y += areaH + fieldGap

	y += d.drawPicture(c, draw, x, y, w) + sectionTop

	if draw {
		c.Paint.Text(c.T("poll.options"), x, y, labelLine, sectionStyle, theme.WithAlpha(c.Theme.Text, labelDim))
		count := itoa(len(d.rows)) + "/" + itoa(chat.PollMaxOptions)
		c.Paint.Text(count, x+w-c.Paint.TextWidth(count, countStyle), y, labelLine, countStyle, c.Theme.Muted)
	}
	y += labelLine + sectionGap
	y += d.drawRows(c, draw, x, y, w)

	d.footer.Placeholder = c.T("poll.footer_placeholder")
	y += d.field(c, draw, c.T("poll.footer"), &d.footer, x, y, w)

	for _, s := range []struct {
		on   *widget.Switch
		text string
	}{{&d.multiple, "poll.multiple"}, {&d.anonymous, "poll.anonymous_switch"}, {&d.timed, "poll.set_end"}} {
		if draw {
			d.drawSwitch(c, s.on, c.T(s.text), x, y)
		}
		y += switchRow + switchMargin
	}
	if d.timed.On {
		d.ends.Placeholder = endsLayout
		if draw {
			box := geom.Rect{X: x + endsIndent, Y: y + (endsHeight-d.ends.Measure(c, 0).H)/2, W: endsWidth, H: d.ends.Measure(c, endsWidth).H}
			d.ends.Draw(c, box)
		}
		y += endsHeight + endsBottom
	}

	if draw && d.problem == chat.PollBadEnd {
		c.Paint.Text(c.T("poll.bad_end"), x, y, noteLine, noteStyle, c.Theme.DangerSoft)
	}
	y += problemHeight + problemGap

	d.cancel.Label, d.send.Label = c.T("poll.cancel"), c.T("poll.send")
	size := d.send.Measure(c, 0)
	if draw {
		right := x + w - size.W
		d.send.Draw(c, geom.Rect{X: right, Y: y, W: size.W, H: size.H})
		cancel := d.cancel.Measure(c, 0)
		d.cancel.Draw(c, geom.Rect{X: right - buttonGap - cancel.W, Y: y, W: cancel.W, H: cancel.H})
	}
	return y + size.H + dialogPadY - r.Y
}

const (
	buttonGap = 8
	insetPad  = 5.6
)

// drawArea is the description: the writing area of the message box in a well like the text fields'.
func (d *Dialog) drawArea(c *widget.Context, r geom.Rect) {
	edge := c.Hairline()
	c.Paint.Fill(r, areaRadius, c.Theme.Bg)
	c.Paint.Stroke(r, areaRadius, edge, theme.WithAlpha(c.Theme.Tint, areaFill))
	inner := r.H - 2*(edge+insetPad)
	d.description.Draw(c, geom.Rect{X: r.X + edge + 1.6, Y: r.Y + edge + insetPad - 8.7, W: r.W - 2*edge - 3.2, H: inner + 16})
}

// drawPicture is the row with the button that adds a picture, or the picture and the button that takes it away.
func (d *Dialog) drawPicture(c *widget.Context, draw bool, x, y, w float32) float32 {
	d.pick.Label, d.remove.Label = c.T("poll.add_picture"), c.T("poll.remove_picture")
	if d.picture == "" {
		size := d.pick.Measure(c, 0)
		if draw {
			d.pick.Draw(c, geom.Rect{X: x, Y: y, W: size.W, H: size.H})
		}
		return size.H
	}
	button := d.remove.Measure(c, 0)
	pw, ph := float32(previewW), float32(previewH)
	var pic *paint.Picture
	if draw {
		pic = c.Paint.Picture("file:"+d.picture, d.fetch)
	} else {
		pic = c.Paint.PeekPicture("file:" + d.picture)
	}
	if pic != nil {
		if iw, ih, ok := pic.Size(); ok {
			scale := min(1, previewW/float32(iw), previewH/float32(ih))
			pw, ph = float32(iw)*scale, float32(ih)*scale
		}
	}
	h := max(button.H, ph)
	if draw {
		c.Paint.DrawPicture(pic, geom.Rect{X: x, Y: y + (h-ph)/2, W: pw, H: ph}, areaRadius, false, c.Theme.Surface2)
		d.remove.Draw(c, geom.Rect{X: x + pw + pictureGap, Y: y + (h-button.H)/2, W: button.W, H: button.H})
	}
	return h
}

func (d *Dialog) drawRows(c *widget.Context, draw bool, x, y, w float32) float32 {
	start := y
	for i, row := range d.rows {
		row.field.Placeholder = c.T("poll.option_placeholder")
		h := row.field.Measure(c, w).H
		if draw {
			row.field.Draw(c, geom.Rect{X: x, Y: y, W: w - optionRowGap - dropSize, H: h})
			if len(d.rows) > chat.PollMinOptions && i < len(d.rows)-1 {
				row.drop.Draw(c, geom.Rect{X: x + w - dropSize, Y: y + (h-dropSize)/2, W: dropSize, H: dropSize})
			}
		}
		y += h
		if i < len(d.rows)-1 {
			y += optionRowGap
		}
	}
	return y - start + optionsBottom
}

// drawSwitch is a switch with its words; a click on the words flips it as well.
func (d *Dialog) drawSwitch(c *widget.Context, s *widget.Switch, text string, x, y float32) {
	size := s.Measure(c, 0)
	s.Draw(c, geom.Rect{X: x, Y: y + 2, W: size.W, H: size.H})
	tx := x + size.W + switchGap
	words := geom.Rect{X: tx, Y: y, W: c.Paint.TextWidth(text, switchStyle), H: switchRow}
	if c.Hovered(words) {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(words) {
			c.Claim()
			s.Toggle()
		}
	}
	c.Paint.Text(text, tx, y, switchLine, switchStyle, c.Theme.Text)
}
