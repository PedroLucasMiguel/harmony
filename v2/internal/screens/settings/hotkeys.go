package settings

import (
	"runtime"
	"strconv"

	"harmony/v2/internal/desktop"
	"harmony/v2/internal/hotkey"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

const (
	hotkeyRowGap     = 6.4
	hotkeyKeyWidth   = 144
	hotkeyGap        = 12
	hotkeyListTop    = 0
	hotkeyHeadingTop = 14.4
	hotkeyHeadSize   = 11.52
	hotkeyProblem    = 12
	hotkeyMargin     = 12.8
	// A key's note on Wayland has no Electron translation.
	hotkeyWayland = "Wayland does not let a program watch keys while another window is in front. Global hotkeys work here only through the desktop's own shortcuts portal, where the desktop asks you to confirm each key."
	hotkeyPTTName = "Push to talk"
)

var isMac = runtime.GOOS == "darwin"

type hotkeys struct {
	d *Dialog
}

func newHotkeys(d *Dialog) *hotkeys { return &hotkeys{d: d} }

func (h *hotkeys) icon() string                   { return "list" }
func (h *hotkeys) label(c *widget.Context) string { return c.T("settings.hotkeys") }

func (h *hotkeys) row(c *widget.Context, id, name string) widget.Component {
	d := h.d.Desktop
	bound := d.Binding(id)
	key := &widget.Button{Variant: widget.Ghost, Small: true, Label: c.T("app.not_set"), OnClick: func() { h.record(c, id, name) }}
	if bound != "" {
		key.Label = hotkey.Format(bound)
	}
	items := []widget.RowItem{
		widget.Grow(&widget.Text{Content: name, Tone: widget.ToneText, Style: paint.TextStyle{Size: 13.6, Weight: paint.Regular}}),
		widget.Fixed(widget.MinWidth{W: hotkeyKeyWidth, Child: key}),
	}
	if bound != "" {
		clear := &widget.Button{Variant: widget.Ghost, Small: true, Label: c.T("app.clear"), OnClick: func() { d.SetBinding(id, ""); h.d.invalidate() }}
		items = append(items, widget.Fixed(clear))
	}
	rows := []widget.Component{&widget.Row{Gap: hotkeyGap, Items: items}}
	if result, ok := d.HotkeyResult(id); ok && bound != "" && !result.OK {
		rows = append(rows, h.problem(c, result.Error))
	}
	return widget.Col(2, rows...)
}

func (h *hotkeys) problem(c *widget.Context, code string) widget.Component {
	text := c.T("hotkeys.err_" + code)
	if code == hotkey.ErrWayland {
		text = hotkeyWayland
	}
	return &widget.Text{Content: text, Wrap: true, Tone: widget.ToneWarn, Style: paint.TextStyle{Size: hotkeyProblem, Weight: paint.Regular}}
}

func (h *hotkeys) record(c *widget.Context, id, name string) {
	RecordHotkey(c, h.d.Desktop, id, name, func() {
		h.d.invalidate()
		c.OpenModal(h.d)
	})
}

func (h *hotkeys) build(c *widget.Context) widget.Component {
	rows := []widget.Component{}
	if code := hotkey.Supported(); code != "" {
		rows = append(rows, h.problem(c, code))
	}
	for _, id := range desktop.Actions {
		rows = append(rows, h.row(c, id, c.T("hotkeys."+id)))
	}
	rows = append(rows, h.row(c, desktop.ActionPTT, hotkeyPTTName))
	if note := h.pushToTalkNote(c); note != "" {
		rows = append(rows, widget.SettingNote{Content: note})
	}
	if isMac && h.permissionMissing() {
		rows = append(rows, widget.Start{Child: &widget.Button{Variant: widget.Ghost, Label: c.T("screen_permission.open_settings"), OnClick: desktop.OpenInputSettings}})
	}
	rows = append(rows, widget.Padded{Top: hotkeyHeadingTop, Child: &widget.Text{
		Content: c.T("app.soundpad_clips"), Upper: true, Tone: widget.ToneMuted,
		Style: paint.TextStyle{Size: hotkeyHeadSize, Weight: paint.Semibold, Spacing: hotkeyHeadSize * 0.06},
	}})
	clips := h.d.Session.Clips()
	if len(clips) == 0 {
		rows = append(rows, widget.SettingNote{Content: c.T("app.this_server_has_no_soundpad")})
	}
	for _, clip := range clips {
		name := clip.Name
		if clip.Emoji != "" {
			name = clip.Emoji + " " + name
		}
		rows = append(rows, h.row(c, "clip:"+strconv.Itoa(clip.ID), name))
	}
	return widget.Col(0,
		widget.PageTitle(c.T("settings.hotkeys.hotkeys")),
		&widget.SettingCard{Children: []widget.Component{
			widget.SettingNote{Content: c.T("settings.hotkeys.work_anywhere_even_while")},
			widget.Padded{Top: hotkeyListTop, Child: widget.Col(hotkeyRowGap, rows...)},
		}},
	)
}

func (h *hotkeys) permissionMissing() bool {
	result, ok := h.d.Desktop.HotkeyResult(desktop.ActionPTT)
	return ok && result.Error == hotkey.ErrPermission
}

// pushToTalkNote says what the push-to-talk key will actually do on this computer.
func (h *hotkeys) pushToTalkNote(c *widget.Context) string {
	if !h.d.Settings.PushToTalk {
		return ""
	}
	if h.d.Desktop.Binding(desktop.ActionPTT) == "" {
		return c.T("ptt.scope_no_key")
	}
	result, ok := h.d.Desktop.HotkeyResult(desktop.ActionPTT)
	switch {
	case !ok || result.OK:
		return c.T("ptt.scope_global")
	case result.Error == hotkey.ErrPermission:
		return c.T("ptt.scope_permission")
	}
	return c.T("ptt.scope_unavailable")
}
