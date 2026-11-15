package serveradmin

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/screens/imageedit"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

const nameDelay = 700 * time.Millisecond

const (
	fieldGap      = 0
	logoSide      = 56
	logoRadius    = 12
	bannerWidth   = 192
	bannerHeight  = 64
	bannerRadius  = 8
	logoGap       = 10
	toggleAfter   = 11.2
	bannerGap     = 12.8
	pickColumnGap = 6.4
	gigabyte      = 1 << 30
	megabyte      = 1 << 20
	storageSlack  = megabyte
	pictureLimit  = 8 << 20
	nameMax       = 32
)

var fileSizes = []int64{8 * megabyte, 25 * megabyte, 50 * megabyte, 100 * megabyte, 250 * megabyte, 500 * megabyte, gigabyte, 2 * gigabyte}

// pendingPicture is a logo or banner that was uploaded and is waiting to be set on the server (or taken off, with no hash).
type pendingPicture struct {
	set  bool
	hash string
}

type generalPage struct {
	d    *Dialog
	save *autosave

	title    widget.TextField
	password widget.TextField
	storage  widget.TextField
	maxFile  widget.Dropdown
	noPass   widget.Switch
	music    widget.Switch

	logoPick, logoRemove, bannerPick, bannerRemove widget.Button

	logo, banner pendingPicture
	seen         hclient.ServerInfo
	synced       bool
	passwordSet  bool
	wantPassword bool
	typed        string
	nameFocused  bool
	passFocused  bool
	fileFocused  bool
}

func newGeneral(d *Dialog) *generalPage {
	p := &generalPage{d: d}
	p.save = d.newAutosave(p.plan)
	p.title.Inset, p.title.MaxLength = true, nameMax
	p.title.OnEnter = func() { p.save.touch(0) }
	p.password.Inset, p.password.Password = true, true
	p.password.OnEnter = p.commitPassword
	p.storage.Inset = true
	p.storage.OnEnter = func() { p.save.touch(0) }
	p.maxFile.OnChange = func(string) { p.save.touch(0) }
	p.noPass.OnChange = p.togglePasswordOff
	p.music.OnChange = p.toggleMusic
	p.logoPick.Variant, p.logoPick.Small, p.logoPick.OnClick = widget.Ghost, true, func() { p.choose(true) }
	p.logoRemove.Variant, p.logoRemove.Small, p.logoRemove.OnClick = widget.Ghost, true, func() { p.clear(true) }
	p.bannerPick.Variant, p.bannerPick.Small, p.bannerPick.OnClick = widget.Ghost, true, func() { p.choose(false) }
	p.bannerRemove.Variant, p.bannerRemove.Small, p.bannerRemove.OnClick = widget.Ghost, true, func() { p.clear(false) }
	return p
}

func (p *generalPage) name() string { return TabGeneral }

func (p *generalPage) icon() string                   { return "gear-six" }
func (p *generalPage) label(c *widget.Context) string { return c.T("server_admin.general") }

func (p *generalPage) visible(a hclient.Actor) bool { return a.Owner }

func (p *generalPage) flush() { p.save.flush() }

func (p *generalPage) commitPassword() {
	if p.password.Value != "" {
		p.passwordSet = true
		p.save.touch(0)
	}
}

func (p *generalPage) togglePasswordOff(on bool) {
	info := p.d.state.Server
	if on {
		p.password.Value, p.passwordSet, p.wantPassword = "", false, false
		p.save.touch(0)
		return
	}
	if !info.PasswordRequired {
		p.wantPassword = true
		p.password.RequestFocus()
	}
}

func (p *generalPage) toggleMusic(on bool) {
	info := p.d.state.Server
	if info.MusicAvailable != nil && !*info.MusicAvailable && !info.MusicEnabled {
		p.music.On = false
		return
	}
	p.save.touch(0)
}

// adopt takes from the server what it changed since the page last looked, leaving what is being typed alone.
func (p *generalPage) adopt(info hclient.ServerInfo) {
	if p.synced && info.Name == p.seen.Name && info.MaxFileBytes == p.seen.MaxFileBytes && info.StorageBytes == p.seen.StorageBytes && info.PasswordRequired == p.seen.PasswordRequired && info.MusicEnabled == p.seen.MusicEnabled {
		p.seen = info
		return
	}
	if !p.synced || info.Name != p.seen.Name {
		p.title.Value = info.Name
	}
	if !p.synced || info.MaxFileBytes != p.seen.MaxFileBytes {
		p.maxFile.Value = strconv.FormatInt(info.MaxFileBytes, 10)
	}
	if !p.synced || info.StorageBytes != p.seen.StorageBytes {
		p.storage.Value = strconv.FormatFloat(math.Round(float64(info.StorageBytes)/gigabyte*100)/100, 'f', -1, 64)
	}
	if !p.synced || info.PasswordRequired != p.seen.PasswordRequired {
		p.wantPassword = false
	}
	p.noPass.On = !info.PasswordRequired && !p.wantPassword
	p.music.On = info.MusicEnabled
	p.seen, p.synced = info, true
}

func (p *generalPage) plan() func(context.Context) error {
	info := p.d.state.Server
	patch := map[string]any{}
	if name := strings.TrimSpace(p.title.Value); name != "" && name != info.Name {
		patch["name"] = name
	}
	logo, banner := p.logo, p.banner
	if logo.set {
		patch["logo"] = nilOr(logo.hash)
	}
	if banner.set {
		patch["banner"] = nilOr(banner.hash)
	}
	password, changed := "", false
	switch {
	case p.noPass.On && info.PasswordRequired:
		changed = true
	case p.passwordSet && p.password.Value != "":
		password, changed = p.password.Value, true
	}
	if changed {
		patch["password"] = password
	}
	if info.MaxFileBytes > 0 {
		if size, err := strconv.ParseInt(p.maxFile.Value, 10, 64); err == nil && size != info.MaxFileBytes {
			patch["maxFileBytes"] = size
		}
		if gb, err := strconv.ParseFloat(strings.TrimSpace(p.storage.Value), 64); err == nil && gb > 0 {
			if bytes := int64(math.Round(gb * gigabyte)); math.Abs(float64(bytes-info.StorageBytes)) > storageSlack {
				patch["storageBytes"] = bytes
			}
		}
	}
	if info.MusicAvailable != nil && p.music.On != info.MusicEnabled {
		patch["musicEnabled"] = p.music.On
	}
	if len(patch) == 0 {
		return nil
	}
	session, c := p.d.Session, p.d.ctx
	return func(ctx context.Context) error {
		sent, err := session.SetServer(ctx, patch)
		if err != nil {
			return err
		}
		if changed {
			session.Client().Password = password
		}
		c.Post(func() {
			if logo.set && p.logo == logo {
				p.logo = pendingPicture{}
			}
			if banner.set && p.banner == banner {
				p.banner = pendingPicture{}
			}
			if changed {
				p.password.Value, p.passwordSet, p.wantPassword = "", false, false
			}
			_ = sent
			p.d.invalidate()
		})
		return nil
	}
}

func nilOr(hash string) any {
	if hash == "" {
		return nil
	}
	return hash
}

// choose asks for a picture, lets it be cut, uploads it and sets it as the logo or the banner.
func (p *generalPage) choose(logo bool) {
	purpose := imageedit.ServerBanner
	if logo {
		purpose = imageedit.ServerLogo
	}
	p.d.editPicture(purpose, p.d.ctx.T("server_logo_pick.choose_image"), func(hash string) {
		if logo {
			p.logo = pendingPicture{set: true, hash: hash}
		} else {
			p.banner = pendingPicture{set: true, hash: hash}
		}
		p.d.invalidate()
		p.save.touch(0)
	})
}

func (p *generalPage) clear(logo bool) {
	if logo {
		p.logo = pendingPicture{set: true}
	} else {
		p.banner = pendingPicture{set: true}
	}
	p.d.invalidate()
	p.save.touch(0)
}

func (p *generalPage) picture(c *widget.Context, pending pendingPicture, current string) (*paint.Picture, string) {
	hash := current
	if pending.set {
		hash = pending.hash
	}
	return p.d.picture(c, hash), hash
}

func (p *generalPage) sizeOptions(info hclient.ServerInfo) []widget.Option {
	var options []widget.Option
	listed := false
	for _, size := range fileSizes {
		listed = listed || size == info.MaxFileBytes
	}
	sizes := fileSizes
	if !listed && info.MaxFileBytes > 0 {
		sizes = append(append([]int64{}, fileSizes...), info.MaxFileBytes)
	}
	for _, size := range sizes {
		options = append(options, widget.Option{Value: strconv.FormatInt(size, 10), Label: formatBytes(size)})
	}
	return options
}

func formatBytes(n int64) string {
	switch {
	case n >= gigabyte:
		return strconv.FormatFloat(float64(n)/gigabyte, 'f', -1, 64) + " GB"
	case n >= megabyte:
		return strconv.FormatInt(int64(math.Round(float64(n)/megabyte)), 10) + " MB"
	}
	return fmt.Sprintf("%d bytes", n)
}

// switchRow is a switch row with the room under it that a field's note has.
func switchRow(row widget.ToggleRow) widget.Component {
	return widget.Padded{Bottom: toggleAfter, Child: row}
}

// field is a labelled control with the quiet line under it.
func field(label string, control widget.Component, hint string) widget.Component {
	parts := []widget.Component{widget.DialogField(label, control)}
	if hint != "" {
		parts = append(parts, widget.SettingNote{Content: hint})
	}
	return widget.Col(0, parts...)
}

func (p *generalPage) build(c *widget.Context) widget.Component {
	info := p.d.state.Server
	p.adopt(info)
	p.logoPick.Label = c.T("server_logo_pick.choose_image")
	p.bannerPick.Label = c.T("server_logo_pick.choose_image")
	p.logoRemove.Label = c.T("server_logo_remove.remove")
	p.bannerRemove.Label = c.T("server_logo_remove.remove")

	logoPic, logoHash := p.picture(c, p.logo, info.LogoHash())
	bannerPic, bannerHash := p.picture(c, p.banner, info.BannerHash())
	p.logoRemove.Disabled, p.bannerRemove.Disabled = logoHash == "", bannerHash == ""
	logo := &widget.Row{Gap: logoGap, Items: []widget.RowItem{
		widget.Fixed(widget.ImageTile{Picture: logoPic, Name: info.Name, Size: geom.Size{W: logoSide, H: logoSide}, Radius: logoRadius}),
		widget.Fixed(&p.logoPick), widget.Fixed(&p.logoRemove),
	}}
	banner := &widget.Row{Gap: bannerGap, Items: []widget.RowItem{
		widget.Fixed(widget.ImageTile{Picture: bannerPic, Size: geom.Size{W: bannerWidth, H: bannerHeight}, Radius: bannerRadius}),
		widget.Fixed(widget.Col(pickColumnGap, widget.Start{Child: &p.bannerPick}, widget.Start{Child: &p.bannerRemove})),
	}}

	passwordHint := c.T("app.this_server_has_no_password")
	if info.PasswordRequired {
		passwordHint = c.T("app.this_server_has_a_password")
	}
	p.password.Placeholder = c.T("server_form.leave_blank_to_keep")

	parts := []widget.Component{
		widget.PageTitle(p.label(c)),
		field(c.T("server_form.name"), p.watched(&p.title, &p.nameFocused, p.nameTyped), c.T("server_form.what_it_is_called")),
		field(c.T("server_form.logo"), logo, c.T("server_form.shown_in_everybody_s")),
		field(c.T("server_form.banner"), banner, c.T("server_form.banner_hint")),
		field(c.T("server_form.password"), p.watched(&p.password, &p.passFocused, p.commitPassword), passwordHint),
		switchRow(widget.ToggleRow{Title: c.T("server_form.no_password_at_all"), Hint: c.T("server_form.anybody_who_can_reach"), Switch: &p.noPass, Flat: true}),
	}
	if info.RestartRequired {
		parts = append(parts, widget.SettingNote{Content: c.T("app.saved_the_media_relay_keeps")})
	}
	if info.MaxFileBytes > 0 {
		p.maxFile.Options = p.sizeOptions(info)
		note := c.T("server.storage_note_short", "used", formatBytes(info.UsedBytes))
		if info.DiskFreeBytes != nil {
			note = c.T("server.storage_note", "used", formatBytes(info.UsedBytes), "free", formatBytes(*info.DiskFreeBytes))
		}
		parts = append(parts,
			field(c.T("server_uploads.largest_file"), &p.maxFile, c.T("server_uploads.the_biggest_file_anybody")),
			field(c.T("server_uploads.space_for_files_gb"), p.watched(&p.storage, &p.fileFocused, func() { p.save.touch(0) }), note),
		)
	}
	if info.MusicAvailable != nil {
		parts = append(parts, switchRow(widget.ToggleRow{Title: c.T("music.owner_label"), Hint: c.T("music.owner_hint"), Switch: &p.music, Flat: true}))
		if !*info.MusicAvailable {
			parts = append(parts, widget.SettingNote{Content: c.T("music.owner_missing")})
		}
	}
	return widget.Col(fieldGap, parts...)
}

func (p *generalPage) nameTyped() { p.save.touch(0) }

// watched is a text field that says when the keyboard leaves it, and, for a name, when it has changed.
func (p *generalPage) watched(f *widget.TextField, focused *bool, leave func()) widget.Component {
	return watch{field: f, focused: focused, leave: leave, typed: p.typedFn(f)}
}

func (p *generalPage) typedFn(f *widget.TextField) func() {
	if f != &p.title {
		return nil
	}
	return func() { p.save.touch(nameDelay) }
}

type watch struct {
	field   *widget.TextField
	focused *bool
	leave   func()
	typed   func()
}

func (w watch) Measure(c *widget.Context, maxWidth float32) geom.Size {
	return w.field.Measure(c, maxWidth)
}

func (w watch) Draw(c *widget.Context, r geom.Rect) {
	before := w.field.Value
	w.field.Draw(c, r)
	if w.typed != nil && w.field.Value != before {
		w.typed()
	}
	now := w.field.Focused(c)
	if *w.focused && !now {
		w.leave()
	}
	*w.focused = now
}
