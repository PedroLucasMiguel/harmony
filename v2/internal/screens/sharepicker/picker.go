// Package sharepicker is the dialog that asks what to share: a screen, a window or a camera, at what resolution and frame
// rate, and starts the share (or, while sharing, changes the source without dropping the viewers).
package sharepicker

import (
	"strconv"
	"strings"
	"sync/atomic"

	"harmony/v2/internal/app"
	"harmony/v2/internal/store"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
	"harmony/v2/internal/video"
	"harmony/v2/internal/video/native"
)

const (
	cardWidth   = 660
	cardMargin  = 16
	padX        = 20
	headTop     = 18
	titleSize   = 17.6
	subSize     = 13
	rowPadY     = 8
	labelSize   = 11
	labelGap    = 6
	gridGap     = 10
	gridMinCol  = 170
	gridMaxH    = 300
	gridMinH    = 120
	gridPad     = 2
	footPadY    = 14
	footGap     = 8
	footTop     = 10
	permPadding = 12.8
	permMargin  = 12.8
)

var (
	titleStyle = paint.TextStyle{Size: titleSize, Weight: paint.Semibold}
	subStyle   = paint.TextStyle{Size: subSize, Weight: paint.Regular}
	labelStyle = paint.TextStyle{Size: labelSize, Weight: paint.Bold, Spacing: 0.04 * labelSize}
	noteStyle  = paint.TextStyle{Size: 12.8, Weight: paint.Regular}
	permBody   = paint.TextStyle{Size: 13.6, Weight: paint.Regular}
)

// Options is what the dialog needs from the program around it.
type Options struct {
	Session  *app.Session
	Settings *store.Settings
	// Target is the channel the share goes to, for the line under the title.
	Target string
	// Encoder is the codec backend to send with.
	Encoder func() string
	// Changing is set while a share is running: the dialog then swaps its source.
	Changing bool
	// Note is a line the footer shows beside the buttons, for what the sound will be.
	Note func(source native.SourceInfo) string
	// Extra are rows the dialog shows between the sources and the quality, for the sound.
	Extra func(source native.SourceInfo) widget.Component
}

// Dialog is the picker.
type Dialog struct {
	opt      Options
	catalog  catalog
	kind     native.SourceKind
	selected string
	res, fps string
	tabs     widget.Segmented
	resSeg   widget.Segmented
	fpsSeg   widget.Segmented
	refresh  widget.Button
	open     widget.Button
	cancel   widget.Button
	start    widget.Button
	grid     widget.Scroll
	cards    []widget.SourceCard
	busy     atomic.Bool
	errText  atomic.Pointer[string]
	opened   bool
}

// New opens the picker over the window.
func New(c *widget.Context, opt Options) *Dialog {
	d := &Dialog{opt: opt, kind: native.KindScreen}
	q := video.ShareQuality{Resolution: opt.Settings.ShareResolution, FPS: opt.Settings.ShareFramerate}.Valid()
	d.res, d.fps = q.Resolution, strconv.Itoa(q.FPS)
	d.catalog.kind = d.kind
	d.tabs = widget.Segmented{
		Options:  []widget.Option{{Value: "screen", Label: c.T("picker.screens")}, {Value: "window", Label: c.T("picker.windows")}, {Value: "camera", Label: c.T("picker.cameras_capture_cards")}},
		Value:    "screen",
		OnChange: d.setKind,
	}
	d.resSeg = widget.Segmented{OnChange: func(v string) { d.res = v }}
	for _, r := range video.ShareResolutions {
		label := r + "p"
		if r == video.ResNative {
			label = c.T("quality.native")
		}
		d.resSeg.Options = append(d.resSeg.Options, widget.Option{Value: r, Label: label})
	}
	d.fpsSeg = widget.Segmented{OnChange: func(v string) { d.fps = v }}
	for _, f := range video.ShareFramerates {
		label := c.T("quality.native")
		if f > 0 {
			label = c.T("quality.fps", "fps", strconv.Itoa(f))
		}
		d.fpsSeg.Options = append(d.fpsSeg.Options, widget.Option{Value: strconv.Itoa(f), Label: label})
	}
	d.refresh = widget.Button{Label: c.T("picker_refresh.refresh"), Variant: widget.Ghost, Small: true, OnClick: d.catalog.load}
	d.open = widget.Button{Label: c.T("screen_permission.open_settings"), Variant: widget.Ghost, OnClick: native.OpenScreenAccessSettings}
	d.cancel = widget.Button{Label: c.T("app.cancel"), Variant: widget.Ghost, OnClick: func() { d.close(c) }}
	d.start = widget.Button{Label: c.T("app.start_streaming"), Variant: widget.Primary, Disabled: true}
	if opt.Changing {
		d.cancel.Label, d.start.Label = c.T("app.back_to_stream"), c.T("app.use_this_source")
	}
	d.start.OnClick = func() { d.begin(c) }
	d.catalog.watch()
	d.catalog.load()
	return d
}

func (d *Dialog) setKind(v string) {
	d.kind = native.SourceKind(v)
	d.tabs.Value = v
	d.catalog.setKind(d.kind)
}

func (d *Dialog) close(c *widget.Context) {
	if d.busy.Load() {
		return
	}
	d.catalog.close()
	c.CloseModal()
}

func (d *Dialog) quality() video.ShareQuality {
	fps, _ := strconv.Atoi(d.fps)
	return video.ShareQuality{Resolution: d.res, FPS: fps, Sharp: d.opt.Settings.SharePriority != "smooth"}.Valid()
}

func (d *Dialog) config() app.ShareConfig {
	return app.ShareConfig{Source: d.selected, Quality: d.quality(), Encoder: d.opt.Encoder(), Auto: d.opt.Settings.ShareAutoAdapt}
}

// begin starts the share, or changes the running one, off the frame loop.
func (d *Dialog) begin(c *widget.Context) {
	if d.selected == "" || d.busy.Swap(true) {
		return
	}
	cfg := d.config()
	st := d.opt.Settings
	st.ShareResolution, st.ShareFramerate = cfg.Quality.Resolution, cfg.Quality.FPS
	st.Save()
	d.errText.Store(nil)
	if d.opt.Changing {
		d.start.Label = c.T("app.switching")
	} else {
		d.start.Label = c.T("app.going_live")
	}
	go func() {
		var err error
		if d.opt.Changing {
			err = d.opt.Session.UpdateShare(cfg)
		} else {
			err = d.opt.Session.StartShareConfig(cfg)
		}
		d.busy.Store(false)
		c.Post(func() {
			if err != nil {
				text := err.Error()
				d.errText.Store(&text)
				d.start.Label = c.T("app.start_streaming")
				if d.opt.Changing {
					d.start.Label = c.T("app.use_this_source")
				}
				return
			}
			d.catalog.close()
			c.CloseModal()
		})
		redraw.Request()
	}()
}

func (d *Dialog) sourcesOfKind() []native.SourceInfo {
	list, _ := d.catalog.snapshot()
	var out []native.SourceInfo
	for _, s := range list {
		if s.Kind == d.kind {
			out = append(out, s)
		}
	}
	return out
}

func (d *Dialog) selectedInfo() (native.SourceInfo, bool) {
	list, _ := d.catalog.snapshot()
	for _, s := range list {
		if s.ID == d.selected {
			return s, true
		}
	}
	return native.SourceInfo{}, false
}

func detail(s native.SourceInfo) string {
	switch {
	case s.Kind == native.KindWindow && s.App != "":
		return s.App
	case s.W > 0 && s.Kind == native.KindScreen:
		return strconv.Itoa(s.W) + "×" + strconv.Itoa(s.H)
	}
	return ""
}

func (d *Dialog) Draw(c *widget.Context, bounds geom.Rect) {
	c.Paint.Fill(bounds, 0, backdrop)
	edge := c.Hairline()
	width := min(cardWidth, bounds.W-2*cardMargin)
	inner := width - 2*padX - 2*edge

	items := d.sourcesOfKind()
	if d.selected != "" {
		found := false
		for _, s := range d.sourcesOfKind() {
			found = found || s.ID == d.selected
		}
		if !found {
			d.selected = ""
		}
	}
	denied := !native.ScreenAccess() && d.kind != native.KindCamera
	_, loading := d.catalog.snapshot()
	d.start.Disabled = d.selected == "" || d.busy.Load()

	var headH float32 = headTop + titleSize*1.4 + 2 + subSize*1.4 + 4
	var labelH float32 = labelSize*1.5 + labelGap
	segH := d.tabs.Measure(c, inner).H
	typeRow := rowPadY + labelH + segH + rowPadY
	permH := float32(0)
	if denied {
		permH = d.permHeight(c, inner)
	}
	gridH := min(gridMaxH, max(gridMinH, bounds.H*0.36))
	srcRow := rowPadY + labelH + gridH + rowPadY
	var extra widget.Component
	var extraH float32
	sel, hasSel := d.selectedInfo()
	if d.opt.Extra != nil && hasSel {
		if extra = d.opt.Extra(sel); extra != nil {
			extraH = extra.Measure(c, inner).H + 2*rowPadY
		}
	}
	qualRow := 2 * (rowPadY + labelH + segH + rowPadY)
	note := d.note(hasSel, sel)
	footH := footPadY*2 + max(d.start.Measure(c, 0).H, noteStyle.Size*1.5)
	total := headH + typeRow + permH + srcRow + extraH + qualRow + footTop + footH + 2*edge
	if total > bounds.H-2*cardMargin {
		gridH = max(gridMinH/2, gridH-(total-(bounds.H-2*cardMargin)))
		total = bounds.H - 2*cardMargin
	}
	card := geom.Rect{X: bounds.X + (bounds.W-width)/2, Y: bounds.Y + (bounds.H-total)/2, W: width, H: total}

	if (c.Clicked(bounds) && !c.Hovered(card)) || c.In.Escape {
		c.Claim()
		d.close(c)
		return
	}
	c.Paint.Fill(card, 12, c.Theme.Surface)
	c.Paint.Stroke(card, 12, edge, c.Theme.Border)
	x, w := card.X+edge+padX, inner
	y := card.Y + edge + headTop
	c.Paint.Text(c.T("picker.choose_what_to_share"), x, y, titleSize*1.4, titleStyle, c.Theme.Text)
	y += titleSize*1.4 + 2
	sub := c.T("picker.streaming_as") + " "
	c.Paint.Text(sub, x, y, subSize*1.4, subStyle, c.Theme.Muted)
	bold := subStyle
	bold.Weight = paint.Bold
	c.Paint.Text(d.opt.Target, x+c.Paint.TextWidth(sub, subStyle), y, subSize*1.4, bold, c.Theme.Muted)
	y = card.Y + edge + headH

	y += rowPadY
	d.label(c, c.T("picker.source_type"), x, y)
	y += labelH
	refreshSize := d.refresh.Measure(c, 0)
	d.tabs.Draw(c, geom.Rect{X: x, Y: y, W: w - refreshSize.W - gridGap, H: segH})
	d.refresh.Draw(c, geom.Rect{X: x + w - refreshSize.W, Y: y + (segH-refreshSize.H)/2, W: refreshSize.W, H: refreshSize.H})
	y += segH + rowPadY

	if denied {
		d.drawPermission(c, geom.Rect{X: x, Y: y, W: w, H: permH})
		y += permH
	}

	y += rowPadY
	d.label(c, c.T("picker.sources"), x, y)
	y += labelH
	d.drawGrid(c, geom.Rect{X: x, Y: y, W: w, H: gridH}, items, loading)
	y += gridH + rowPadY

	if extra != nil {
		y += rowPadY
		extra.Draw(c, geom.Rect{X: x, Y: y, W: w, H: extraH - 2*rowPadY})
		y += extraH - rowPadY
	}

	for _, row := range []struct {
		label string
		seg   *widget.Segmented
		val   string
	}{{c.T("picker.resolution"), &d.resSeg, d.res}, {c.T("picker.framerate"), &d.fpsSeg, d.fps}} {
		y += rowPadY
		d.label(c, row.label, x, y)
		y += labelH
		row.seg.Value = row.val
		row.seg.Draw(c, geom.Rect{X: x, Y: y, W: w, H: segH})
		y += segH + rowPadY
	}

	foot := geom.Rect{X: card.X + edge, Y: card.Bottom() - edge - footH, W: width - 2*edge, H: footH}
	c.Paint.Fill(foot, 0, c.Theme.Surface2)
	c.Paint.Fill(geom.Rect{X: foot.X, Y: foot.Y, W: foot.W, H: edge}, 0, c.Theme.Border)
	d.drawFoot(c, foot, note, x, w)
}

func (d *Dialog) note(has bool, s native.SourceInfo) string {
	if e := d.errText.Load(); e != nil {
		return *e
	}
	if d.opt.Note != nil && has {
		return d.opt.Note(s)
	}
	return ""
}

func (d *Dialog) label(c *widget.Context, text string, x, y float32) {
	c.Paint.Text(strings.ToUpper(text), x, y, labelSize*1.5, labelStyle, c.Theme.Muted)
}

func (d *Dialog) drawFoot(c *widget.Context, foot geom.Rect, note string, x, w float32) {
	start, cancel := d.start.Measure(c, 0), d.cancel.Measure(c, 0)
	by := foot.Y + (foot.H-start.H)/2
	sx := x + w - start.W
	cx := sx - footGap - cancel.W
	d.start.Draw(c, geom.Rect{X: sx, Y: by, W: start.W, H: start.H})
	d.cancel.Draw(c, geom.Rect{X: cx, Y: by, W: cancel.W, H: cancel.H})
	if note != "" {
		ink := c.Theme.Muted
		if d.errText.Load() != nil {
			ink = c.Theme.Warn
		}
		area := geom.Rect{X: x, Y: foot.Y, W: cx - footGap - x, H: foot.H}
		c.Paint.TextIn(area, note, area.X, foot.Y+(foot.H-noteStyle.Size*1.5)/2, noteStyle.Size*1.5, noteStyle, ink)
	}
}
