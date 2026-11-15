package settings

import (
	"os/exec"
	"runtime"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/debuglog"
	"harmony/v2/internal/filedialog"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

const (
	debugViewLines  = 8
	debugViewSize   = 11.52
	debugViewLine   = 16
	debugViewPad    = 9.6
	debugViewRadius = 8
	debugActionsTop = 6.4
	debugActionGap  = 8
	// The log view's buttons have no Electron translation: that page has no list.
	debugCopy    = "Copy"
	debugSave    = "Save as…"
	debugClear   = "Clear"
	debugEmpty   = "Nothing has been logged yet."
	debugSaveAs  = "Save the log"
	debugViewKey = "Recent lines"
)

type debug struct {
	d *Dialog

	dump  widget.Switch
	err   string
	view  logView
	open  widget.Button
	copy  widget.Button
	save  widget.Button
	clear widget.Button
}

func newDebug(d *Dialog) *debug {
	g := &debug{d: d}
	g.dump.On = debuglog.Path() != ""
	g.dump.OnChange = g.toggle
	g.open = widget.Button{Variant: widget.Ghost, Icon: "folder-open", OnClick: openLogFolder}
	g.copy = widget.Button{Variant: widget.Ghost, Label: debugCopy, OnClick: func() { rl.SetClipboardText(debuglog.Text()) }}
	g.save = widget.Button{Variant: widget.Ghost, Label: debugSave, OnClick: g.saveAs}
	g.clear = widget.Button{Variant: widget.Ghost, Label: debugClear, OnClick: func() { debuglog.Clear(); d.invalidate() }}
	return g
}

func (g *debug) icon() string                   { return "bug" }
func (g *debug) label(c *widget.Context) string { return c.T("settings.debug") }

func (g *debug) toggle(on bool) {
	if !on {
		debuglog.Stop()
		g.err = ""
		g.d.invalidate()
		return
	}
	if _, err := debuglog.Start(); err != nil {
		g.err = g.d.ctx.T("settings.debug.failed", "message", err.Error())
		g.dump.On = false
	}
	g.d.invalidate()
}

func (g *debug) saveAs() {
	go func() {
		if path := filedialog.Save(debugSaveAs, "harmony-debug.txt"); path != "" {
			_ = debuglog.Save(path)
		}
	}()
}

func openLogFolder() {
	dir := debuglog.Dir()
	switch runtime.GOOS {
	case "darwin":
		_ = exec.Command("open", dir).Start()
	case "windows":
		_ = exec.Command("explorer", dir).Start()
	default:
		_ = exec.Command("xdg-open", dir).Start()
	}
}

func (g *debug) build(c *widget.Context) widget.Component {
	g.open.Label = c.T("settings.debug.open_folder")
	g.dump.On = debuglog.Path() != ""
	card := []widget.Component{
		widget.ToggleRow{Title: c.T("settings.debug.dump_to_log"), Hint: c.T("settings.debug.dump_to_log_hint"), Switch: &g.dump},
	}
	if path := debuglog.Path(); path != "" {
		card = append(card, widget.Padded{Top: 6.4, Child: &widget.Text{Content: c.T("settings.debug.logging_to", "file", path), Tone: widget.ToneMuted, Wrap: true, Style: paint.TextStyle{Size: 12.8, Weight: paint.Regular}}})
	}
	if g.err != "" {
		card = append(card, widget.Padded{Top: 6.4, Child: &widget.Text{Content: g.err, Tone: widget.ToneDanger, Wrap: true, Style: paint.TextStyle{Size: 12.8, Weight: paint.Regular}}})
	}
	card = append(card, widget.Padded{Top: debugActionsTop, Child: widget.Start{Child: &g.open}})
	return widget.Col(0,
		widget.PageTitle(c.T("settings.debug.debug")),
		&widget.SettingCard{Children: card},
		&widget.SettingCard{Title: debugViewKey, Children: []widget.Component{
			&g.view,
			widget.Padded{Top: debugActionsTop, Child: &widget.Row{Gap: debugActionGap, Items: []widget.RowItem{
				widget.Fixed(&g.copy), widget.Fixed(&g.save), widget.Fixed(&g.clear),
			}}},
		}},
	)
}

// logView shows the last lines of the log, read again whenever a line has been added since the last frame.
type logView struct {
	version uint64
	lines   []string
}

func (v *logView) refresh() {
	if version := debuglog.Version(); version != v.version || v.lines == nil {
		all := debuglog.Lines()
		v.lines = all[max(0, len(all)-debugViewLines):]
		v.version = version
	}
}

func (v *logView) Measure(_ *widget.Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: debugViewLines*debugViewLine + 2*debugViewPad}
}

func (v *logView) Draw(c *widget.Context, r geom.Rect) {
	v.refresh()
	c.Paint.Fill(r, debugViewRadius, c.Theme.Bg)
	c.Paint.Stroke(r, debugViewRadius, c.Hairline(), c.Theme.Border)
	inner := r.InsetAll(debugViewPad)
	style := paint.TextStyle{Size: debugViewSize, Weight: paint.Regular, Mono: true}
	c.Paint.PushClip(inner)
	defer c.Paint.PopClip()
	if len(v.lines) == 0 {
		c.Paint.Text(debugEmpty, inner.X, inner.Y, debugViewLine, style, c.Theme.Muted)
		return
	}
	for i, line := range v.lines {
		c.Paint.Text(line[:len(line)-1], inner.X, inner.Y+float32(i)*debugViewLine, debugViewLine, style, c.Theme.Text)
	}
}
