package settings

import (
	"context"
	"time"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/people"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
)

const (
	tileMinWidth = 168
	tileGap      = 8
	defaultSolid = "#5865f2"
)

// look is the Name font and Name colour cards of the page.
type look struct {
	p      *profile
	colors widget.NameStyleEditor
	seen   *hclient.NameStyle
	due    time.Time
	synced bool
}

func newLook(p *profile) *look {
	k := &look{p: p}
	k.colors.Bare = true
	k.colors.OnChange = func(delay time.Duration) {
		k.due = time.Now().Add(delay)
		redraw.After(delay)
	}
	return k
}

func (k *look) saveFont(font string) {
	c, s := k.p.d.ctx, k.p.d.Session
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), nameTimeout)
		defer cancel()
		err := s.SetNameFont(ctx, font)
		c.Post(func() {
			if err != nil {
				k.p.notes.font.set(err.Error(), true)
			} else {
				k.p.notes.font.set(c.T("profile.font_saved"), false)
			}
			k.p.d.invalidate()
		})
	}()
}

func (k *look) saveColor(style *hclient.NameStyle) {
	c, s := k.p.d.ctx, k.p.d.Session
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), nameTimeout)
		defer cancel()
		err := s.SetNameColor(ctx, style)
		c.Post(func() {
			if err != nil {
				k.p.notes.color.set(err.Error(), true)
			} else {
				k.p.notes.color.set(c.T("profile.color_saved"), false)
			}
			k.p.d.invalidate()
		})
	}()
}

func valueOf(s *hclient.NameStyle) widget.NameStyleValue {
	if s == nil {
		return widget.NameStyleValue{Color: defaultSolid}
	}
	return widget.NameStyleValue{Mode: s.Mode, Color: s.Color, Colors: s.Colors, Speed: s.Speed}
}

func styleOf(v widget.NameStyleValue) *hclient.NameStyle {
	switch v.Mode {
	case "solid":
		return &hclient.NameStyle{Mode: "solid", Color: v.Color}
	case "gradient":
		return &hclient.NameStyle{Mode: "gradient", Colors: v.Colors, Speed: v.Speed}
	case "rainbow":
		return &hclient.NameStyle{Mode: "rainbow", Speed: v.Speed}
	}
	return nil
}

func sameStyle(a, b *hclient.NameStyle) bool {
	if a == nil || b == nil {
		return a == b
	}
	if a.Mode != b.Mode || a.Color != b.Color || a.Speed != b.Speed || len(a.Colors) != len(b.Colors) {
		return false
	}
	for i := range a.Colors {
		if a.Colors[i] != b.Colors[i] {
			return false
		}
	}
	return true
}

// pickMode is a tile of the colour card: "" goes back to the role's colour.
func (k *look) pickMode(mode string) {
	if mode == "" {
		k.due = time.Time{}
		k.saveColor(nil)
		return
	}
	if k.colors.Value.Mode == "" {
		k.colors.Value = widget.NameStyleValue{Color: defaultSolid}
	}
	k.colors.Choose(mode)
}

// sync takes the server's colour into the editor unless the person is in the middle of changing it.
func (k *look) sync(current *hclient.NameStyle) {
	if k.synced && k.due.IsZero() && sameStyle(k.seen, current) {
		return
	}
	if !k.due.IsZero() {
		return
	}
	k.seen, k.synced = current, true
	k.colors.Set(valueOf(current))
	if current == nil {
		k.colors.Value.Mode = ""
	}
}

func (k *look) cards(c *widget.Context, me *meView) []widget.Component {
	entry := c.People.ByID(me.id)
	tiles := []widget.Component{widget.NameTile{Label: c.T("profile.font_default"), On: me.font == "", OnClick: func() { k.saveFont("") }}}
	sample := me.name
	for _, id := range hclient.NameFonts {
		style := people.Style{Family: paint.FamilyOf(id)}
		tiles = append(tiles, widget.NameTile{Label: sample, Look: &style, On: me.font == id, OnClick: func() { k.saveFont(id) }})
	}
	fontCard := &widget.SettingCard{Title: c.T("settings.profile.name_font"), Children: append([]widget.Component{
		widget.Padded{Bottom: groupGap, Child: &widget.Grid{MinCell: tileMinWidth, Gap: tileGap, Children: tiles}},
		widget.SettingNote{Content: c.T("settings.profile.name_font_note")},
	}, k.p.notes.font.component()...)}

	k.sync(me.nameColor)
	var role people.Style
	if entry != nil {
		role = c.People.RoleStyle(entry)
	}
	solid := people.StyleFor("solid", defaultSolid, nil, 0)
	gradient := people.StyleFor("gradient", "", []string{"#8e2de2", "#00c6ff"}, 6)
	rainbow := people.StyleFor("rainbow", "", nil, 6)
	mode := ""
	if me.nameColor != nil {
		mode = me.nameColor.Mode
	}
	k.colors.Labels.Add, k.colors.Labels.Speed = c.T("profile.color_add"), c.T("profile.color_speed")
	k.colors.SpeedWidth = 160
	modes := []widget.Component{
		widget.NameTile{Label: sample, Look: &role, On: mode == "", OnClick: func() { k.pickMode("") }},
		widget.NameTile{Label: c.T("profile.color_solid"), Look: &solid, On: mode == "solid", OnClick: func() { k.pickMode("solid") }},
		widget.NameTile{Label: c.T("profile.color_gradient"), Look: &gradient, On: mode == "gradient", OnClick: func() { k.pickMode("gradient") }},
		widget.NameTile{Label: c.T("profile.color_rainbow"), Look: &rainbow, On: mode == "rainbow", OnClick: func() { k.pickMode("rainbow") }},
	}
	body := []widget.Component{widget.Padded{Bottom: groupGap, Child: &widget.Grid{MinCell: tileMinWidth, Gap: tileGap, Children: modes}}}
	if me.nameColor != nil {
		body = append(body, widget.Padded{Bottom: groupGap, Child: &colorEditor{k: k}})
	}
	body = append(body, widget.SettingNote{Content: c.T("settings.profile.name_color_note")})
	colorCard := &widget.SettingCard{Title: c.T("settings.profile.name_color"), Children: append(body, k.p.notes.color.component()...)}
	return []widget.Component{fontCard, colorCard}
}

// colorEditor is the editor under the colour tiles; it sends the colour once the hand has been still for a moment.
type colorEditor struct{ k *look }

func (e *colorEditor) Measure(c *widget.Context, w float32) geom.Size {
	return e.k.colors.Measure(c, w)
}

func (e *colorEditor) Draw(c *widget.Context, r geom.Rect) {
	k := e.k
	if !k.due.IsZero() {
		if left := time.Until(k.due); left > 0 {
			redraw.After(left)
		} else {
			k.due = time.Time{}
			if k.colors.Value.Valid() {
				if st := styleOf(k.colors.Value); st != nil {
					k.seen = st
					k.saveColor(st)
				}
			}
		}
	}
	k.colors.Draw(c, r)
}
