package channels

import (
	"strconv"
	"strings"
	"time"

	"harmony/v2/internal/app"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
	"harmony/v2/internal/video"
)

const (
	shareBarPad     = 4
	shareBarGap     = 10
	shareTitleSize  = 15
	shareStatsSize  = 12.8
	shareStatsPadY  = 6
	shareFieldGap   = 6
	shareDropWidth  = 118
	shareDropPrio   = 190
	shareLabelSize  = 13
	shareStatsEvery = time.Second
)

var (
	shareTitleStyle = paint.TextStyle{Size: shareTitleSize, Weight: paint.Semibold}
	shareLabelStyle = paint.TextStyle{Size: shareLabelSize, Weight: paint.Regular}
	shareStatsStyle = paint.TextStyle{Size: shareStatsSize, Weight: paint.Regular}
)

// shareBar is what you steer your own share with while it runs: the resolution, frame rate and priority, whether it lowers
// itself, a way to change what is shared or stop, and under the stage the live line about the stream.
type shareBar struct {
	res, fps, prio widget.Dropdown
	auto           widget.Switch
	change, stop   widget.Button
	menu           widget.ContextMenu
	menuAt         geom.Rect
	ready          bool
	fields         [4]*inlineField
}

// inlineField is a small label before its control.
type inlineField struct {
	label   string
	control widget.Component
	width   float32
}

func (f *inlineField) Measure(c *widget.Context, maxWidth float32) geom.Size {
	h := f.control.Measure(c, f.width).H
	return geom.Size{W: min(maxWidth, c.Paint.TextWidth(f.label, shareLabelStyle)+shareFieldGap+f.width), H: h}
}

func (f *inlineField) Draw(c *widget.Context, r geom.Rect) {
	lw := c.Paint.TextWidth(f.label, shareLabelStyle)
	line := float32(shareLabelSize * 1.5)
	c.Paint.Text(f.label, r.X, r.Y+(r.H-line)/2, line, shareLabelStyle, c.Theme.Muted)
	f.control.Draw(c, geom.Rect{X: r.X + lw + shareFieldGap, Y: r.Y, W: f.width, H: r.H})
}

func (s *Screen) initShareBar(c *widget.Context) {
	b := &s.shareBar
	b.ready = true
	for _, r := range video.ShareResolutions {
		label := r + "p"
		if r == video.ResNative {
			label = c.T("quality.native")
		}
		b.res.Options = append(b.res.Options, widget.Option{Value: r, Label: label})
	}
	for _, f := range video.ShareFramerates {
		label := c.T("quality.native")
		if f > 0 {
			label = c.T("quality.fps", "fps", strconv.Itoa(f))
		}
		b.fps.Options = append(b.fps.Options, widget.Option{Value: strconv.Itoa(f), Label: label})
	}
	b.prio.Options = []widget.Option{{Value: "sharp", Label: c.T("priority.sharp")}, {Value: "smooth", Label: c.T("priority.smooth")}}
	b.res.OnChange = func(v string) { s.updateShare(func(cfg *app.ShareConfig) { cfg.Quality.Resolution = v }) }
	b.fps.OnChange = func(v string) {
		n, _ := strconv.Atoi(v)
		s.updateShare(func(cfg *app.ShareConfig) { cfg.Quality.FPS = n })
	}
	b.prio.OnChange = func(v string) { s.updateShare(func(cfg *app.ShareConfig) { cfg.Quality.Sharp = v == "sharp" }) }
	b.auto.OnChange = func(on bool) { s.updateShare(func(cfg *app.ShareConfig) { cfg.Auto = on }) }
	b.change = widget.Button{Label: c.T("change_source.change_source"), Variant: widget.Ghost, Small: true, OnClick: func() {
		if s.ShareHooks.Change != nil {
			s.ShareHooks.Change()
		}
	}}
	b.stop = widget.Button{Label: c.T("stop_stream.stop_streaming"), Variant: widget.Ghost, Danger: true, Small: true, OnClick: func() { go s.Session.StopShare() }}
	b.fields = [4]*inlineField{
		{label: c.T("view.broadcast.resolution"), control: &b.res, width: shareDropWidth},
		{label: c.T("view.broadcast.framerate"), control: &b.fps, width: shareDropWidth},
		{label: c.T("view.broadcast.priority"), control: &b.prio, width: shareDropPrio},
	}
}

// updateShare changes the running share and what is kept for the next one, off the frame loop.
func (s *Screen) updateShare(change func(*app.ShareConfig)) {
	cfg, on := s.Session.ShareConfig()
	if !on {
		return
	}
	change(&cfg)
	st := s.Settings
	st.ShareResolution, st.ShareFramerate, st.ShareAutoAdapt = cfg.Quality.Resolution, cfg.Quality.FPS, cfg.Auto
	st.SharePriority = "smooth"
	if cfg.Quality.Sharp {
		st.SharePriority = "sharp"
	}
	st.Save()
	go func() {
		if err := s.Session.UpdateShare(cfg); err != nil {
			s.say(err.Error())
		}
	}()
}

// drawShareBar draws the share's controls above the stage and its live line under it, and returns what is left for the stage.
func (s *Screen) drawShareBar(c *widget.Context, area geom.Rect, m model) geom.Rect {
	cfg, on := s.Session.ShareConfig()
	if !on || !m.state.Sharing {
		return area
	}
	b := &s.shareBar
	if !b.ready {
		s.initShareBar(c)
	}
	b.res.Value, b.fps.Value = cfg.Quality.Resolution, strconv.Itoa(cfg.Quality.FPS)
	b.prio.Value = "smooth"
	if cfg.Quality.Sharp {
		b.prio.Value = "sharp"
	}
	b.auto.On = cfg.Auto

	title := c.T("app.sharing_in", "name", "#"+m.joined.Name)
	line := float32(shareTitleSize * 1.5)
	changeSize, stopSize := b.change.Measure(c, 0), b.stop.Measure(c, 0)
	flow := widget.Flow{Gap: shareBarGap * 1.6, RowGap: shareBarGap / 2}
	for _, f := range b.fields[:3] {
		flow.Items = append(flow.Items, f)
	}
	flow.Items = append(flow.Items, &switchField{label: c.T("view.broadcast.auto_adapt"), sw: &b.auto})
	flowH := flow.Measure(c, area.W-2*shareBarPad).H
	head := max(line, changeSize.H)
	barH := shareBarPad + head + shareBarGap/2 + flowH + shareBarPad
	statsH := float32(shareStatsSize*1.5*2 + 2*shareStatsPadY)

	x, y := area.X+shareBarPad, area.Y+shareBarPad
	c.Paint.Circle(x+4, y+head/2, 4, c.Theme.Danger)
	c.Paint.Text(title, x+16, y+(head-line)/2, line, shareTitleStyle, c.Theme.Text)
	right := area.Right() - shareBarPad
	b.stop.Draw(c, geom.Rect{X: right - stopSize.W, Y: y + (head-stopSize.H)/2, W: stopSize.W, H: stopSize.H})
	right -= stopSize.W + 6
	b.change.Draw(c, geom.Rect{X: right - changeSize.W, Y: y + (head-changeSize.H)/2, W: changeSize.W, H: changeSize.H})
	flow.Draw(c, geom.Rect{X: x, Y: y + head + shareBarGap/2, W: area.W - 2*shareBarPad, H: flowH})

	stage := geom.Rect{X: area.X, Y: area.Y + barH, W: area.W, H: max(0, area.H-barH-statsH)}
	s.drawShareStats(c, geom.Rect{X: area.X, Y: stage.Bottom(), W: area.W, H: statsH}, cfg)
	redraw.After(shareStatsEvery)
	return stage
}

// switchField is a switch with its label after it.
type switchField struct {
	label string
	sw    *widget.Switch
}

func (f *switchField) Measure(c *widget.Context, maxWidth float32) geom.Size {
	sw := f.sw.Measure(c, 0)
	return geom.Size{W: sw.W + shareFieldGap + c.Paint.TextWidth(f.label, shareLabelStyle), H: sw.H}
}

func (f *switchField) Draw(c *widget.Context, r geom.Rect) {
	sw := f.sw.Measure(c, 0)
	f.sw.Draw(c, geom.Rect{X: r.X, Y: r.Y, W: sw.W, H: sw.H})
	line := float32(shareLabelSize * 1.5)
	tx := r.X + sw.W + shareFieldGap
	c.Paint.Text(f.label, tx, r.Y+(r.H-line)/2, line, shareLabelStyle, c.Theme.Muted)
	label := geom.Rect{X: tx, Y: r.Y, W: r.W - sw.W - shareFieldGap, H: r.H}
	if c.Clicked(label) {
		c.Claim()
		f.sw.Toggle()
	}
}

// drawShareStats is the line under the stream: size, frame rate, bit rate, the encoder's time, and why it is lowered.
func (s *Screen) drawShareStats(c *widget.Context, r geom.Rect, cfg app.ShareConfig) {
	st := s.Session.ShareStats()
	line := float32(shareStatsSize * 1.5)
	text := c.T("app.connecting")
	if st.Live {
		var bits []string
		if st.Width > 0 {
			bits = append(bits, strconv.Itoa(st.Width)+"×"+strconv.Itoa(st.Height))
		}
		if fps := int(st.FPS + 0.5); fps > 0 {
			bits = append(bits, strconv.Itoa(fps)+" fps")
		}
		if st.Kbps > 0 {
			bits = append(bits, strconv.FormatFloat(float64(st.Kbps)/1000, 'f', 1, 64)+" Mbps")
		}
		bits = append(bits, st.Codec)
		if st.RTT > 0 {
			bits = append(bits, strconv.Itoa(int(st.RTT.Milliseconds()))+" ms")
		}
		if st.EncodeKnown {
			bits = append(bits, c.T("stats.encode", "ms", strconv.FormatFloat(st.EncodeMs, 'f', 1, 64)))
		}
		if st.Mode != "" {
			bits = append(bits, st.Mode)
		}
		text = strings.Join(bits, "  ·  ")
	}
	x, y := r.X+shareBarPad, r.Y+shareStatsPadY
	c.Paint.TextIn(r, text, x, y, line, shareStatsStyle, c.Theme.Muted)
	limit := ""
	switch {
	case st.Lowered:
		size := ""
		if st.LoweredHeight > 0 {
			size = strconv.Itoa(st.LoweredHeight) + "p"
		}
		limit = c.T("limit.adapted", "size", size, "fps", strconv.Itoa(st.LoweredFPS))
	case st.LinkLimited:
		limit = c.T("limit.bandwidth")
	}
	if limit != "" {
		c.Paint.TextIn(r, limit, x, y+line, line, shareStatsStyle, c.Theme.Warn)
	}
}
