package settings

import (
	"context"
	"strconv"
	"sync"
	"time"

	"harmony/v2/internal/imagecrop"
	"harmony/v2/internal/screens/imageedit"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	uploadTimeout    = 60 * time.Second
	pictureSize      = 69.16
	pictureFont      = 36.4
	pictureGap       = 18
	profileButtonGap = 8
	groupGap         = 10
	previewHeight    = 41.6
	previewRadius    = 6
	previewPadX      = 8
	previewAvatar    = 12.6
	previewAvatarTxt = 8.4
	previewName      = 13.16
	previewFill      = 0.05
	defaultDim       = 50
	dimSendDelay     = 80 * time.Millisecond
	headHeight       = 28.8
	headGap          = 12
	headSize         = 14.4
)

// picture is the Picture and Banner cards of the page.
type picture struct {
	p        *profile
	choose   widget.Button
	remove   widget.Button
	banner   widget.Button
	unbanner widget.Button
	reset    widget.Button
	dim      widget.Slider
	mu       sync.Mutex
	sending  bool
	wanted   *int
}

func newPicture(p *profile) *picture {
	k := &picture{p: p}
	k.choose.OnClick = k.chooseFace
	k.remove.Variant, k.remove.OnClick = widget.Ghost, func() { k.clear(true) }
	k.banner.OnClick = k.chooseBanner
	k.unbanner.Variant, k.unbanner.OnClick = widget.Ghost, func() { k.clear(false) }
	k.reset.Variant, k.reset.OnClick = widget.Ghost, func() { k.setDim(nil) }
	k.dim.Min, k.dim.Max, k.dim.Step = 0, 100, 1
	k.dim.OnChange = func(v int) { k.setDim(&v) }
	return k
}

func (k *picture) chooseFace() {
	c := k.p.d.ctx
	imageedit.Choose(c, imageedit.ProfilePicture, func(res imagecrop.Result) { k.upload(res, true) }, func(msg string) { k.report(true, msg, true) })
}

func (k *picture) chooseBanner() {
	c := k.p.d.ctx
	imageedit.Choose(c, imageedit.ProfileBanner, func(res imagecrop.Result) { k.upload(res, false) }, func(msg string) { k.report(false, msg, true) })
}

func (k *picture) report(face bool, text string, failed bool) {
	n := &k.p.notes.banner
	if face {
		n = &k.p.notes.picture
	}
	n.set(text, failed)
	k.p.d.invalidate()
}

func (k *picture) upload(res imagecrop.Result, face bool) {
	c, s := k.p.d.ctx, k.p.d.Session
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), uploadTimeout)
		defer cancel()
		hash, err := s.UploadFile(ctx, res.Data, res.ContentType)
		if err == nil && face {
			err = s.SetAvatar(ctx, hash)
		} else if err == nil {
			err = s.SetBanner(ctx, hash)
		}
		c.Post(func() { k.done(face, err, "profile.picture_changed", "profile.banner_changed") })
	}()
}

func (k *picture) clear(face bool) {
	c, s := k.p.d.ctx, k.p.d.Session
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), nameTimeout)
		defer cancel()
		var err error
		if face {
			err = s.SetAvatar(ctx, "")
		} else {
			err = s.SetBanner(ctx, "")
		}
		c.Post(func() { k.done(face, err, "profile.picture_removed", "profile.banner_removed") })
	}()
}

func (k *picture) done(face bool, err error, faceKey, bannerKey string) {
	c := k.p.d.ctx
	key := bannerKey
	if face {
		key = faceKey
	}
	if err != nil {
		k.report(face, err.Error(), true)
		return
	}
	k.report(face, c.T(key), false)
}

// setDim shows the dimming at once and tells the server soon, one request at a time with the latest value in it, so that answers
// arriving out of order cannot put an old one back.
func (k *picture) setDim(v *int) {
	s := k.p.d.Session
	s.ShowBannerDim(v)
	k.p.d.invalidate()
	k.mu.Lock()
	k.wanted = v
	if k.sending {
		k.mu.Unlock()
		return
	}
	k.sending = true
	k.mu.Unlock()
	c := k.p.d.ctx
	go func() {
		time.Sleep(dimSendDelay)
		for {
			k.mu.Lock()
			want := k.wanted
			k.mu.Unlock()
			ctx, cancel := context.WithTimeout(context.Background(), nameTimeout)
			err := s.SetBannerDim(ctx, want)
			cancel()
			k.mu.Lock()
			if err != nil || sameDim(k.wanted, want) {
				k.sending = false
				k.mu.Unlock()
				s.ReleaseBannerDim()
				if err != nil {
					c.Post(func() { k.report(false, err.Error(), true) })
				}
				return
			}
			k.mu.Unlock()
		}
	}()
}

func sameDim(a, b *int) bool { return (a == nil && b == nil) || (a != nil && b != nil && *a == *b) }

func (k *picture) cards(c *widget.Context, me *meView) []widget.Component {
	k.choose.Label, k.remove.Label = c.T("profile_choose.change_picture"), c.T("profile_remove.remove_picture")
	k.remove.Disabled = me.avatarHash == ""
	face := widget.Padded{Bottom: groupGap, Child: &widget.Row{Gap: pictureGap, Items: []widget.RowItem{
		widget.Fixed(widget.Avatar{ID: me.id, Name: me.name, Size: pictureSize, Font: pictureFont}),
		widget.Fixed(&widget.Row{Gap: profileButtonGap, Items: []widget.RowItem{widget.Fixed(&k.choose), widget.Fixed(&k.remove)}}),
	}}}
	pictureCard := &widget.SettingCard{Title: c.T("settings.profile.picture"), Children: append([]widget.Component{
		face, widget.SettingNote{Content: c.T("settings.profile.shown_to_everybody_on")},
	}, k.p.notes.picture.component()...)}

	k.banner.Label, k.unbanner.Label = c.T("profile_banner.choose_banner"), c.T("profile_banner.remove_banner")
	k.unbanner.Disabled = me.bannerHash == ""
	k.reset.Label = c.T("settings.profile.banner_dim_reset")
	k.reset.Disabled = me.bannerHash == "" || me.bannerDim == nil
	dim := defaultDim
	if me.bannerDim != nil {
		dim = *me.bannerDim
	}
	k.dim.Value = dim
	bannerCard := &widget.SettingCard{Title: c.T("settings.profile.banner"), Children: append([]widget.Component{
		widget.Padded{Bottom: groupGap, Child: bannerPreview{me: me}},
		widget.Padded{Bottom: groupGap, Child: &widget.Row{Gap: profileButtonGap, Items: []widget.RowItem{widget.Fixed(&k.banner), widget.Fixed(&k.unbanner)}}},
		headRow{label: c.T("settings.profile.banner_dim"), value: strconv.Itoa(dim) + "%"},
		widget.Padded{Bottom: widget.RangeAfter, Child: widget.RangeRow{Slider: &k.dim}},
		widget.Padded{Bottom: groupGap, Child: widget.Start{Child: &k.reset}},
		widget.SettingNote{Content: c.T("settings.profile.banner_note")},
	}, k.p.notes.banner.component()...)}
	return []widget.Component{pictureCard, bannerCard}
}

// headRow is a second title inside a card, with a value on its right.
type headRow struct{ label, value string }

func (headRow) Measure(_ *widget.Context, w float32) geom.Size { return geom.Size{W: w, H: headHeight} }

func (h headRow) Draw(c *widget.Context, r geom.Rect) {
	style := paint.TextStyle{Size: headSize, Weight: paint.Semibold}
	c.Paint.Text(h.label, r.X, r.Y+(r.H-headSize*1.5)/2, headSize*1.5, style, c.Theme.Text)
	pill := widget.ValuePill{Content: h.value}
	size := pill.Measure(c, 0)
	pill.Draw(c, geom.Rect{X: r.Right() - size.W, Y: r.Y + (r.H-size.H)/2, W: size.W, H: size.H})
}

// bannerPreview is a member list row as people see it, with the banner behind it.
type bannerPreview struct{ me *meView }

func (bannerPreview) Measure(_ *widget.Context, w float32) geom.Size {
	return geom.Size{W: w, H: previewHeight}
}

func (b bannerPreview) Draw(c *widget.Context, r geom.Rect) {
	c.Paint.Fill(r, previewRadius, theme.WithAlpha(c.Theme.Tint, previewFill))
	c.DrawBannerStrip(b.me.bannerHash, b.me.bannerDim, r, previewRadius, c.Theme.Surface)
	face := geom.Rect{X: r.X + previewPadX, Y: r.Y + (r.H-previewAvatar)/2, W: previewAvatar, H: previewAvatar}
	widget.Avatar{ID: b.me.id, Name: b.me.name, Size: previewAvatar, Font: previewAvatarTxt}.Draw(c, face)
	style := paint.TextStyle{Size: previewName, Weight: paint.Regular}
	look := c.NameStyle(b.me.id, b.me.name)
	line := float32(previewName * 1.5)
	c.DrawName(b.me.name, look, face.Right()+previewPadX, r.Y+(r.H-line)/2, line, style, c.Theme.Text)
}
