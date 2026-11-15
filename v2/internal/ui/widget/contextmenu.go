package widget

import (
	"image/color"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	ctxPad         = 5.6
	ctxRadius      = 12
	ctxMinWidth    = 224
	ctxMaxWidth    = 320
	ctxItemPadY    = 7.2
	ctxItemPadX    = 8.8
	ctxItemGap     = 9.6
	ctxItemRadius  = 8
	ctxItemIcon    = 17
	ctxItemSize    = 14.08
	ctxItemLine    = 21.12
	ctxItemSpacing = 1
	ctxHeadPadTop  = 5.6
	ctxHeadPadX    = 8
	ctxHeadPadBot  = 8
	ctxHeadGap     = 8
	ctxHeadAvatar  = 28
	ctxHeadFont    = 11
	ctxHeadSize    = 15.2
	ctxHeadMargin  = 4.8
	ctxNameBot     = 6.4
	ctxHover       = 0.16
	ctxDangerHover = 0.18
	ctxShadowY     = 10
	ctxShadowBlur  = 30
	ctxShadowAlpha = 115
	ctxMargin      = 8
	ctxRuleMargin  = 4.8
)

// MenuItem is one entry of a ContextMenu.
type MenuItem struct {
	Icon   string
	Label  string
	Danger bool
	// On draws the entry in the accent colour, like a switch that is on.
	On bool
	// Volume makes the entry a slider with its percentage, in place of a line of text.
	Volume *VolumeRow
	// Rule makes the entry a hairline between groups of entries.
	Rule   bool
	OnPick func()
}

// ContextMenu is a small list opened at a point with a right-click or a button: an optional head saying whom it is about, and entries that act when pressed.
// A press anywhere else, or Escape, puts it away.
type ContextMenu struct {
	Head string
	// HeadID is the account whose picture the head shows; zero draws the initial of Head.
	HeadID int
	Items  []MenuItem
	// NameOnly writes the head as a plain name, without the picture, for a menu about a thing and not a person.
	NameOnly bool

	open   bool
	fresh  bool
	atX    float32
	atY    float32
	paint  func()
	c      *Context
	bounds geom.Rect
	anchor geom.Rect
}

func (m *ContextMenu) IsOpen() bool { return m.open }

func (m *ContextMenu) Close() { m.open = false }

// OpenAt opens the menu with its top left corner at a point.
func (m *ContextMenu) OpenAt(x, y float32) {
	m.open, m.fresh, m.atX, m.atY = true, true, x, y
	m.anchor = geom.Rect{}
}

// OpenBelow opens the menu under a button, its right edge on the button's.
func (m *ContextMenu) OpenBelow(button geom.Rect) {
	m.open, m.fresh = true, true
	m.anchor = button
	m.atX, m.atY = button.Right(), button.Bottom()+4
}

func (m *ContextMenu) width(c *Context) float32 {
	w := float32(ctxMinWidth)
	style := paint.TextStyle{Size: ctxItemSize, Weight: paint.Medium}
	for _, it := range m.Items {
		w = max(w, 2*(ctxPad+c.Hairline())+2*ctxItemPadX+m.lead()+c.Paint.TextWidth(it.Label, style))
	}
	return min(w, ctxMaxWidth)
}

// lead is the room kept before the labels for the icons, when any entry has one.
func (m *ContextMenu) lead() float32 {
	for _, it := range m.Items {
		if it.Icon != "" {
			return ctxItemIcon + ctxItemGap
		}
	}
	return 0
}

func (m *ContextMenu) itemHeight(c *Context, it MenuItem) float32 {
	switch {
	case it.Rule:
		return 2*ctxRuleMargin + c.Hairline()
	case it.Volume != nil:
		return it.Volume.Measure(c, 0).H
	}
	return 2*ctxItemPadY + ctxItemLine
}

// editing is whether a volume entry is taking typed digits, in which case Escape is for it and not for the menu.
func (m *ContextMenu) editing() bool {
	for _, it := range m.Items {
		if it.Volume != nil && it.Volume.editing {
			return true
		}
	}
	return false
}

func (m *ContextMenu) headHeight() float32 {
	if m.NameOnly {
		return ctxHeadPadTop + ctxHeadSize*1.5 + ctxNameBot
	}
	return ctxHeadPadTop + ctxHeadAvatar + ctxHeadPadBot
}

func (m *ContextMenu) height(c *Context) float32 {
	h := 2*(ctxPad+c.Hairline()) + float32(len(m.Items)-1)*ctxItemSpacing
	for _, it := range m.Items {
		h += m.itemHeight(c, it)
	}
	if m.Head != "" {
		h += m.headHeight() + c.Hairline() + ctxHeadMargin
	}
	return h
}

// Show draws the menu over everything while it is open.
func (m *ContextMenu) Show(c *Context) {
	if !m.open {
		return
	}
	m.c = c
	if m.paint == nil {
		m.paint = m.draw
	}
	c.Overlay(m.paint)
}

func (m *ContextMenu) draw() {
	c := m.c
	edge := c.Hairline()
	box := geom.Rect{W: m.width(c), H: m.height(c)}
	box.X, box.Y = m.atX, m.atY
	if m.anchor.W > 0 {
		box.X = m.atX - box.W
	}
	box.X = max(ctxMargin, min(box.X, c.Viewport.W-box.W-ctxMargin))
	box.Y = max(ctxMargin, min(box.Y, c.Viewport.H-box.H-ctxMargin))
	m.bounds = box
	c.Popup(box)
	c.Layer(m)

	inside := box.Contains(c.In.MouseX, c.In.MouseY)
	if !m.fresh && (c.EscapeFor(m) && !m.editing() || (c.In.Pressed || c.In.RightPressed) && !inside && !m.anchor.Contains(c.In.MouseX, c.In.MouseY)) {
		m.open = false
		return
	}
	m.fresh = false
	if inside && c.In.Pressed {
		c.Claim()
	}
	c.Paint.Shadow(box, ctxRadius, ctxShadowY, ctxShadowBlur, color.RGBA{A: ctxShadowAlpha})
	c.Paint.Fill(box, ctxRadius, c.Theme.Surface)
	c.Paint.Stroke(box, ctxRadius, edge, c.Theme.BorderStrong)
	y := box.Y + edge + ctxPad
	x, w := box.X+edge+ctxPad, box.W-2*(edge+ctxPad)
	if m.Head != "" {
		m.drawHead(c, x, y, w)
		y += m.headHeight() + edge + ctxHeadMargin
	}
	style := paint.TextStyle{Size: ctxItemSize, Weight: paint.Medium}
	for i, it := range m.Items {
		row := geom.Rect{X: x, Y: y, W: w, H: m.itemHeight(c, it)}
		y += row.H + ctxItemSpacing
		if it.Rule {
			c.Paint.Fill(geom.Rect{X: row.X + 3.2, Y: row.Y + ctxRuleMargin, W: row.W - 6.4, H: edge}, 0, c.Theme.Border)
			continue
		}
		if it.Volume != nil {
			it.Volume.Draw(c, row)
			continue
		}
		ink, icon := c.Theme.Text, c.Theme.Muted
		if it.Danger {
			ink, icon = c.Theme.DangerSoft, c.Theme.DangerSoft
		}
		if it.On {
			ink = c.Theme.Accent
		}
		if c.Hovered(row) {
			c.SetCursor(rl.MouseCursorPointingHand)
			fill, lit := theme.WithAlpha(c.Theme.Accent, ctxHover), c.Theme.Accent
			if it.Danger {
				fill, lit = theme.WithAlpha(c.Theme.Danger, ctxDangerHover), c.Theme.DangerSoft
			}
			c.Paint.Fill(row, ctxItemRadius, fill)
			icon = lit
			if c.Clicked(row) {
				c.Claim()
				m.open = false
				if m.Items[i].OnPick != nil {
					m.Items[i].OnPick()
				}
			}
		}
		if it.Icon != "" {
			c.Paint.Icon(it.Icon, geom.Rect{X: row.X + ctxItemPadX, Y: row.Y + (row.H-ctxItemIcon)/2, W: ctxItemIcon, H: ctxItemIcon}, icon)
		}
		c.Paint.TextIn(row, it.Label, row.X+ctxItemPadX+m.lead(), row.Y+ctxItemPadY, ctxItemLine, style, ink)
	}
}

func (m *ContextMenu) drawHead(c *Context, x, y, w float32) {
	edge := c.Hairline()
	if m.NameOnly {
		line := float32(ctxHeadSize * 1.5)
		at := x + ctxHeadPadX
		c.Paint.TextIn(geom.Rect{X: at, Y: y, W: x + w - at - ctxHeadPadX, H: m.headHeight()}, m.Head, at, y+ctxHeadPadTop, line, paint.TextStyle{Size: ctxHeadSize, Weight: paint.Bold}, c.Theme.Text)
		c.Paint.Fill(geom.Rect{X: x, Y: y + m.headHeight(), W: w, H: edge}, 0, c.Theme.Border)
		return
	}
	Avatar{ID: m.HeadID, Name: m.Head, Size: ctxHeadAvatar, Font: ctxHeadFont}.Draw(c, geom.Rect{X: x + ctxHeadPadX, Y: y + ctxHeadPadTop, W: ctxHeadAvatar, H: ctxHeadAvatar})
	line := float32(ctxHeadSize * 1.5)
	at := x + ctxHeadPadX + ctxHeadAvatar + ctxHeadGap
	c.Paint.TextIn(geom.Rect{X: at, Y: y, W: x + w - at, H: line + ctxHeadPadTop + ctxHeadPadBot}, m.Head, at, y+ctxHeadPadTop+(ctxHeadAvatar-line)/2, line, paint.TextStyle{Size: ctxHeadSize, Weight: paint.Semibold}, c.Theme.Text)
	c.Paint.Fill(geom.Rect{X: x, Y: y + ctxHeadPadTop + ctxHeadAvatar + ctxHeadPadBot, W: w, H: edge}, 0, c.Theme.Border)
}
