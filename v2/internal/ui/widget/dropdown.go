package widget

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

type Option struct{ Value, Label string }

const (
	dropdownPadY     = 6.25
	dropdownPadX     = 11.2
	dropdownRadius   = 6
	dropdownSize     = 14
	dropdownLine     = 16.5
	dropdownEdge     = 0.16
	dropdownChevronX = 8
	dropdownChevronW = 4
	dropdownChevronH = 3.2

	dropChipRadius   = 8
	chipPadLeft      = 10
	chipPadRight     = 4
	chipIconSize     = 16.8
	chipIconGap      = 6
	chipTextLead     = 8
	chipArrowGap     = 7.88
	chipArrowWidth   = 7.8
	chipArrowTail    = 4
	chipTextSize     = 12.8
	chipPadY         = 6
	menuItemPadY     = 7
	menuItemPadX     = 12
	menuRadius       = 8
	menuGap          = 4
	dropdownMenuMax  = 308
	menuViewportEdge = 8
)

var (
	dropdownStyle = paint.TextStyle{Size: dropdownSize, Weight: paint.Regular}
	chipStyle     = paint.TextStyle{Size: chipTextSize, Weight: paint.Regular}
)

// Dropdown opens its choices below it, or above when there is no room, and scrolls them when there are many. By default it is as wide
// as its column, in a darker well; with an Icon it is a compact chip as wide as its longest choice, its menu aligned to the right edge.
type Dropdown struct {
	Icon     string
	Options  []Option
	Value    string
	OnChange func(string)
	// Disabled keeps it from opening and shows it dimmed.
	Disabled bool

	open   bool
	offset float32
}

func (d *Dropdown) chip() bool { return d.Icon != "" }

func (d *Dropdown) label() string {
	for _, o := range d.Options {
		if o.Value == d.Value {
			return o.Label
		}
	}
	return ""
}

func (d *Dropdown) style() paint.TextStyle {
	if d.chip() {
		return chipStyle
	}
	return dropdownStyle
}

func (d *Dropdown) widestOption(c *Context) float32 {
	widest := float32(0)
	for _, o := range d.Options {
		widest = max(widest, c.Paint.TextWidth(o.Label, chipStyle))
	}
	return widest
}

func (d *Dropdown) Measure(c *Context, maxWidth float32) geom.Size {
	if !d.chip() {
		return geom.Size{W: maxWidth, H: dropdownLine + 2*dropdownPadY + 2*c.Hairline()}
	}
	width := 2*c.Hairline() + chipPadLeft + chipIconSize + chipIconGap + chipTextLead +
		d.widestOption(c) + chipArrowGap + chipArrowWidth + chipArrowTail + chipPadRight
	return geom.Size{W: width, H: dropdownLine + 2*chipPadY + 2*c.Hairline()}
}

func (d *Dropdown) rowHeight() float32 { return dropdownLine + 2*menuItemPadY }

func (d *Dropdown) menuRect(c *Context, anchor geom.Rect) geom.Rect {
	menu := geom.Rect{X: anchor.X, W: anchor.W}
	if d.chip() {
		menu.W = d.widestOption(c) + 2*menuItemPadX
		menu.X = anchor.Right() - menu.W
	}
	menu.H = min(float32(len(d.Options))*d.rowHeight(), dropdownMenuMax)
	menu.Y = anchor.Bottom() + menuGap
	if menu.Bottom() > c.Viewport.H-menuViewportEdge && anchor.Y-menuGap-menu.H >= menuViewportEdge {
		menu.Y = anchor.Y - menuGap - menu.H
	}
	return menu
}

func (d *Dropdown) Draw(c *Context, r geom.Rect) {
	hovered := c.Hovered(r) && !d.Disabled
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	if d.Disabled {
		d.open = false
	}
	if hovered && c.In.Pressed {
		c.Claim()
		d.open = !d.open
		d.offset = 0
	} else if c.EscapeFor(d) {
		d.open = false
	} else if c.In.Pressed {
		d.open = d.open && d.menuRect(c, r).Contains(c.In.MouseX, c.In.MouseY)
	}
	if d.open {
		c.Layer(d)
	}
	if d.chip() {
		d.drawChip(c, r, hovered)
	} else {
		d.drawWell(c, r)
	}
	if d.open {
		c.Overlay(func() { d.drawMenu(c, r) })
	}
}

func (d *Dropdown) drawWell(c *Context, r geom.Rect) {
	edge, ink := theme.WithAlpha(c.Theme.Tint, dropdownEdge), c.Theme.Text
	if d.open {
		edge = c.Theme.Accent
	}
	if d.Disabled {
		ink = c.Theme.Muted
	}
	c.Paint.Fill(r, dropdownRadius, c.Theme.Bg)
	c.Paint.Stroke(r, dropdownRadius, c.Hairline(), edge)
	c.Paint.Text(d.label(), r.X+c.Hairline()+dropdownPadX, r.Y+(r.H-dropdownLine)/2, dropdownLine, dropdownStyle, ink)
	cx, cy := r.Right()-c.Hairline()-dropdownChevronX, r.Y+r.H/2
	c.Paint.Line(cx-dropdownChevronW, cy-dropdownChevronH/2, cx, cy+dropdownChevronH/2, 1.2, ink)
	c.Paint.Line(cx, cy+dropdownChevronH/2, cx+dropdownChevronW, cy-dropdownChevronH/2, 1.2, ink)
}

func (d *Dropdown) drawChip(c *Context, r geom.Rect, hovered bool) {
	ink, edge := c.Theme.Muted, c.Theme.Border
	if hovered || d.open {
		ink, edge = c.Theme.Text, c.Theme.BorderStrong
	}
	c.Paint.Fill(r, dropChipRadius, c.Theme.Surface2)
	c.Paint.Stroke(r, dropChipRadius, c.Hairline(), edge)
	x := r.X + c.Hairline() + chipPadLeft
	c.Paint.Icon(d.Icon, geom.Rect{X: x, Y: r.Y + (r.H-chipIconSize)/2, W: chipIconSize, H: chipIconSize}, ink)
	x += chipIconSize + chipIconGap + chipTextLead
	c.Paint.Text(d.label(), x, r.Y+(r.H-dropdownLine)/2, dropdownLine, chipStyle, ink)
	cx, cy := r.Right()-c.Hairline()-chipPadRight-chipArrowTail-chipArrowWidth/2, r.Y+r.H/2
	c.Paint.Line(cx-3.9, cy-2, cx, cy+2.1, 1.2, ink)
	c.Paint.Line(cx, cy+2.1, cx+3.9, cy-2, 1.2, ink)
}

func (d *Dropdown) drawMenu(c *Context, anchor geom.Rect) {
	menu := d.menuRect(c, anchor)
	c.Popup(menu)
	rowHeight := d.rowHeight()
	if menu.Contains(c.In.MouseX, c.In.MouseY) {
		d.offset -= c.In.Wheel * scrollStep
	}
	d.offset = min(max(d.offset, 0), max(0, float32(len(d.Options))*rowHeight-menu.H))
	c.Paint.Fill(menu, menuRadius, c.Theme.Surface)
	c.Paint.Stroke(menu, menuRadius, c.Hairline(), c.Theme.Border)
	c.Paint.PushClip(menu)
	defer c.Paint.PopClip()
	for i, o := range d.Options {
		row := geom.Rect{X: menu.X, Y: menu.Y + float32(i)*rowHeight - d.offset, W: menu.W, H: rowHeight}
		if row.Bottom() < menu.Y || row.Y > menu.Bottom() {
			continue
		}
		if c.Hovered(row.Intersect(menu)) {
			c.Paint.Fill(row.InsetAll(c.Hairline()), menuRadius-1, c.Theme.Surface2)
			if c.In.Pressed {
				c.Claim()
				d.Value, d.open = o.Value, false
				if d.OnChange != nil {
					d.OnChange(o.Value)
				}
			}
		}
		ink := c.Theme.Text
		if o.Value == d.Value {
			ink = c.Theme.Accent
		}
		c.Paint.Text(o.Label, row.X+menuItemPadX, row.Y+menuItemPadY, dropdownLine, d.style(), ink)
	}
}
