package settings

import (
	"strconv"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
	"harmony/v2/internal/updater"
)

const (
	updateGap      = 10
	updateTextGap  = 2
	updateTitle    = 14.4
	updateStatus   = 12.48
	updateReleases = "Release notes"
	// The newest release is out, but not for this system or this client.
	updateMissing  = "Version {version} is out, but it has no build of this client for this system."
	updateDownload = "Download"
	updateReady    = "Version {version} is downloaded. Restart to use it."
	updateReadonly = "This program's folder cannot be written to, so it cannot replace itself."
)

type updates struct {
	d *Dialog

	check, action, notes widget.Button
	failure              string
}

func newUpdates(d *Dialog) *updates {
	u := &updates{d: d}
	u.check = widget.Button{Variant: widget.Ghost, Small: true, OnClick: func() { go d.Desktop.Updater.Check() }}
	u.action.OnClick = u.act
	u.notes = widget.Button{Variant: widget.Link, OnClick: func() { rl.OpenURL(d.Desktop.Updater.Page()) }}
	return u
}

func (u *updates) icon() string                   { return "download-simple" }
func (u *updates) label(c *widget.Context) string { return c.T("settings.updates") }

func (u *updates) act() {
	up := u.d.Desktop.Updater
	switch s := up.Status(); s.State {
	case updater.Available, updater.Failed:
		up.Download()
	case updater.Ready:
		if err := up.Install(); err != nil {
			u.failure = err.Error()
			u.d.invalidate()
		}
	case updater.Missing:
		rl.OpenURL(up.Page())
	}
}

func (u *updates) status(c *widget.Context, s updater.Status) string {
	switch s.State {
	case updater.Checking:
		return c.T("updates.checking")
	case updater.Latest:
		return c.T("updates.latest")
	case updater.Available:
		return c.T("updates.available", "version", s.Version)
	case updater.Missing:
		return replaceVersion(updateMissing, s.Version)
	case updater.Downloading:
		return c.T("updates.downloading", "version", s.Version, "percent", strconv.Itoa(s.Percent))
	case updater.Ready:
		return replaceVersion(updateReady, s.Version)
	case updater.Failed:
		return c.T("updates.error", "message", s.Error)
	case updater.Unsupported:
		if s.Reason == "development" {
			return c.T("updates.unsupported_development")
		}
		return updateReadonly
	}
	return c.T("updates.idle")
}

func replaceVersion(text, version string) string {
	for i := 0; i+len("{version}") <= len(text); i++ {
		if text[i:i+len("{version}")] == "{version}" {
			return text[:i] + version + text[i+len("{version}"):]
		}
	}
	return text
}

func (u *updates) actionLabel(c *widget.Context, s updater.Status) string {
	switch s.State {
	case updater.Available, updater.Failed:
		return updateDownload
	case updater.Ready:
		return c.T("updates.restart_now")
	case updater.Missing:
		return c.T("updates.open_page")
	}
	return ""
}

func (u *updates) build(c *widget.Context) widget.Component {
	s := u.d.Desktop.Updater.Status()
	u.check.Label = c.T("update_check.check_now")
	u.check.Disabled = s.State == updater.Checking || s.State == updater.Downloading || s.State == updater.Unsupported
	u.notes.Label = updateReleases
	status := u.status(c, s)
	if u.failure != "" {
		status = c.T("updates.error", "message", u.failure)
	}
	items := []widget.RowItem{
		widget.Grow(widget.Col(updateTextGap,
			widget.Label("Harmony "+s.Current, updateTitle, paint.Semibold, widget.ToneText),
			&widget.Text{Content: status, Wrap: true, Tone: widget.ToneMuted, Style: paint.TextStyle{Size: updateStatus, Weight: paint.Regular}},
		)),
		widget.Fixed(&u.check),
	}
	if label := u.actionLabel(c, s); label != "" {
		u.action.Label = label
		items = append(items, widget.Fixed(&u.action))
	}
	card := []widget.Component{&widget.Row{Gap: updateGap, Items: items}}
	if s.Page != "" {
		card = append(card, widget.Padded{Top: updateGap, Child: widget.Start{Child: &u.notes}})
	}
	return widget.Col(0, widget.PageTitle(c.T("settings.updates.updates")), &widget.SettingCard{Children: card})
}
