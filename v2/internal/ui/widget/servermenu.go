package widget

import (
	"image/color"
	"strings"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	menuPadding      = 8
	menuListGap      = 6
	menuMaxHeight    = 360
	menuViewportGap  = 8
	menuShadowDY     = 10
	menuShadowBlur   = 28
	menuShadowAlpha  = 115
	optionPadY       = 7
	optionPadX       = 8
	optionGap        = 8
	optionRadius     = 6
	optionTitleSize  = 14
	optionDetailSize = 12
	optionLine       = 1.25
	optionHoverAlpha = 0.06
	optionPickAlpha  = 0.16
	forgetPadX       = 6
	forgetGlyph      = 7
	addPad           = 8
	addTextSize      = 14
	emptyPad         = 8
	emptySize        = 13
)

type ServerOption struct {
	URL      string
	Name     string
	Host     string
	Username string
	Status   ServerStatus
	Current  bool
}

func (o ServerOption) title() string {
	if o.Name != "" {
		return o.Name
	}
	return o.Host
}

func (o ServerOption) detail(as string) string {
	var parts []string
	if o.Name != "" {
		parts = append(parts, o.Host)
	}
	if o.Username != "" {
		parts = append(parts, as+" "+o.Username)
	}
	return strings.Join(parts, " · ")
}

func (o ServerOption) matches(query string) bool {
	for _, v := range []string{o.URL, o.Name, o.Username} {
		if v != "" && strings.Contains(strings.ToLower(v), query) {
			return true
		}
	}
	return false
}

// ServerMenu is the list of saved servers that drops down from the server chip.
type ServerMenu struct {
	Options     []ServerOption
	Placeholder string
	Empty       string
	AddLabel    string
	AsLabel     string
	OnSelect    func(url string)
	OnForget    func(url string)
	OnAdd       func()
	OnOpen      func()

	open   bool
	search TextField
	list   Scroll
}

func (m *ServerMenu) Open() bool { return m.open }

func (m *ServerMenu) Toggle() {
	m.open = !m.open
	if m.open {
		m.search.Search = true
		m.search.Value = ""
		m.search.RequestFocus()
		if m.OnOpen != nil {
			m.OnOpen()
		}
	}
}

func (m *ServerMenu) Close() { m.open = false }

func (m *ServerMenu) shown() []ServerOption {
	query := strings.ToLower(strings.TrimSpace(m.search.Value))
	var shown []ServerOption
	for _, o := range m.Options {
		if query == "" || o.matches(query) {
			shown = append(shown, o)
		}
	}
	return shown
}

// Show draws the open menu over everything else, under the chip or above it when there is no room.
func (m *ServerMenu) Show(c *Context, chip geom.Rect) {
	if !m.open {
		return
	}
	c.Overlay(func() { m.draw(c, chip) })
}

func (o ServerOption) height(as string) float32 {
	text := float32(optionTitleSize * optionLine)
	if o.detail(as) != "" {
		text += optionDetailSize * optionLine
	}
	return 2*optionPadY + max(chipBadge, text)
}

func (m *ServerMenu) draw(c *Context, chip geom.Rect) {
	inner := chip.W - 2*(menuPadding+c.Hairline())
	shown := m.shown()
	m.search.OnEnter = func() {
		if len(shown) > 0 {
			m.pick(shown[0].URL)
		}
	}
	m.search.Placeholder = m.Placeholder
	searchH := m.search.Measure(c, inner).H
	addH := 2*addPad + addTextSize*1.5 + 2*c.Hairline()
	frame := 2 * (menuPadding + c.Hairline())
	listH := float32(0)
	for _, o := range shown {
		listH += o.height(m.AsLabel)
	}
	if len(shown) == 0 {
		listH = 2*emptyPad + emptySize*1.5
	}
	limit := min(menuMaxHeight, c.Viewport.H-2*menuViewportGap)
	listH = min(listH, limit-frame-searchH-addH-2*menuListGap)
	height := frame + searchH + listH + addH + 2*menuListGap

	top := chip.Bottom() + menuGap
	if top+height > c.Viewport.H-menuViewportGap {
		top = max(menuViewportGap, chip.Y-menuGap-height)
	}
	menu := geom.Rect{X: chip.X, Y: top, W: chip.W, H: height}
	c.Popup(menu)
	c.Layer(m)
	if c.In.Pressed && menu.Contains(c.In.MouseX, c.In.MouseY) {
		c.Claim()
	}

	if c.EscapeFor(m) || (c.In.Pressed && !menu.Contains(c.In.MouseX, c.In.MouseY) && !chip.Contains(c.In.MouseX, c.In.MouseY)) {
		m.open = false
		return
	}
	c.Paint.Shadow(menu, c.Theme.Radius, menuShadowDY, menuShadowBlur, color.RGBA{A: menuShadowAlpha})
	c.Paint.Fill(menu, c.Theme.Radius, c.Theme.Surface2)
	c.Paint.Stroke(menu, c.Theme.Radius, c.Hairline(), c.Theme.BorderStrong)

	content := menu.InsetAll(menuPadding + c.Hairline())
	m.search.Draw(c, geom.Rect{X: content.X, Y: content.Y, W: content.W, H: searchH})
	list := geom.Rect{X: content.X, Y: content.Y + searchH + menuListGap, W: content.W, H: listH}
	m.drawList(c, list, shown)
	m.drawAdd(c, geom.Rect{X: content.X, Y: list.Bottom() + menuListGap, W: content.W, H: addH})
}

func (m *ServerMenu) pick(url string) {
	m.open = false
	if m.OnSelect != nil {
		m.OnSelect(url)
	}
}

func (m *ServerMenu) drawList(c *Context, r geom.Rect, shown []ServerOption) {
	if len(shown) == 0 {
		c.Paint.Text(m.Empty, r.X+emptyPad, r.Y+emptyPad, emptySize*1.5, paint.TextStyle{Size: emptySize, Weight: paint.Regular}, c.Theme.Muted)
		return
	}
	rows := make([]Component, len(shown))
	for i, o := range shown {
		rows[i] = &optionRow{menu: m, option: o}
	}
	m.list.Child = Col(0, rows...)
	m.list.Draw(c, r)
}

func (m *ServerMenu) drawAdd(c *Context, r geom.Rect) {
	hovered := c.Hovered(r)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
		c.Paint.Fill(r, optionRadius, theme.WithAlpha(c.Theme.Accent, 0.08))
	}
	edge := c.Theme.BorderStrong
	if hovered {
		edge = c.Theme.Accent
	}
	c.Paint.DashedRoundRect(r, optionRadius, c.Hairline(), 3, 1.4, edge)
	style := paint.TextStyle{Size: addTextSize, Weight: paint.Semibold}
	width := c.Paint.TextWidth(m.AddLabel, style)
	c.Paint.Text(m.AddLabel, r.X+(r.W-width)/2, r.Y+addPad+c.Hairline(), addTextSize*1.5, style, c.Theme.Accent)
	if c.Clicked(r) {
		c.Claim()
		m.open = false
		if m.OnAdd != nil {
			m.OnAdd()
		}
	}
}

type optionRow struct {
	menu   *ServerMenu
	option ServerOption
}

func (o *optionRow) Measure(_ *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: o.option.height(o.menu.AsLabel)}
}

func (o *optionRow) Draw(c *Context, r geom.Rect) {
	hovered := c.Hovered(r)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	switch {
	case o.option.Current:
		c.Paint.Fill(r, optionRadius, theme.WithAlpha(c.Theme.Accent, optionPickAlpha))
	case hovered:
		c.Paint.Fill(r, optionRadius, theme.WithAlpha(c.Theme.Tint, optionHoverAlpha))
	}

	badge := geom.Rect{X: r.X + optionPadX, Y: r.Y + (r.H-chipBadge)/2, W: chipBadge, H: chipBadge}
	drawServerBadge(c, badge, o.option.title(), o.option.Status)

	right := r.Right() - optionPadX
	forget := o.drawTrailing(c, r, right, hovered)

	textX := badge.Right() + optionGap
	o.drawText(c, geom.Rect{X: textX, Y: r.Y, W: right - textX - optionGap, H: r.H})
	if c.Clicked(r) && !forget {
		c.Claim()
		o.menu.pick(o.option.URL)
	}
}

// drawTrailing draws the tick for the current server, or the forget cross for another; it reports a click on the cross.
func (o *optionRow) drawTrailing(c *Context, r geom.Rect, right float32, rowHovered bool) bool {
	cy := r.Y + r.H/2
	if o.option.Current {
		ink := c.Theme.Accent
		c.Paint.Line(right-11, cy+0.2, right-7.8, cy+3.4, 1.6, ink)
		c.Paint.Line(right-8, cy+3.4, right-1, cy-3.8, 1.6, ink)
		return false
	}
	if !rowHovered {
		return false
	}
	zone := geom.Rect{X: right - forgetGlyph - 2*forgetPadX, Y: cy - 8, W: forgetGlyph + 2*forgetPadX, H: 16}
	over := c.Hovered(zone)
	ink := c.Theme.Muted
	if over {
		ink = c.Theme.DangerSoft
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	mx := zone.X + zone.W/2
	c.Paint.Line(mx-forgetGlyph/2, cy-forgetGlyph/2, mx+forgetGlyph/2, cy+forgetGlyph/2, 1.4, ink)
	c.Paint.Line(mx-forgetGlyph/2, cy+forgetGlyph/2, mx+forgetGlyph/2, cy-forgetGlyph/2, 1.4, ink)
	if over && c.Clicked(zone) {
		c.Claim()
		if o.menu.OnForget != nil {
			o.menu.OnForget(o.option.URL)
		}
		return true
	}
	return false
}

func (o *optionRow) drawText(c *Context, r geom.Rect) {
	titleLine, detailLine := float32(optionTitleSize*optionLine), float32(optionDetailSize*optionLine)
	detail := o.option.detail(o.menu.AsLabel)
	block := titleLine
	if detail != "" {
		block += detailLine
	}
	top := r.Y + (r.H-block)/2
	c.Paint.PushClip(r)
	c.Paint.Text(o.option.title(), r.X, top, titleLine, paint.TextStyle{Size: optionTitleSize, Weight: paint.Semibold}, c.Theme.Text)
	if detail != "" {
		c.Paint.Text(detail, r.X, top+titleLine, detailLine, paint.TextStyle{Size: optionDetailSize, Weight: paint.Regular}, c.Theme.Muted)
	}
	c.Paint.PopClip()
}
