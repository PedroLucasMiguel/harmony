package widget

import (
	"image/color"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

// TitleBarHeight is the bar across the top of the window, in CSS pixels.
const TitleBarHeight = 32

const (
	barSidePad     = 12
	barButtonW     = 26
	barButtonH     = 24
	barButtonGap   = 2
	barButtonR     = 6
	barButtonIcon  = 15
	barButtonHover = 0.12
	barTitleGap    = 8
	barBadge       = 18
	barBadgeR      = 5
	barTitleMax    = 0.4
	controlW       = 46
	controlGlyph   = 10
	controlHover   = 0.1
)

var (
	barTitleStyle = paint.TextStyle{Size: 13.12, Weight: paint.Semibold}
	barBadgeStyle = paint.TextStyle{Size: 10, Weight: paint.Bold}
	closeHover    = color.RGBA{232, 17, 35, 255}
)

// TitleBar is the slim bar across the top of the window: the server's name at the middle, about at the end, and where the
// window has no frame of its own the buttons that minimise, maximise and close it. Pressing the bare bar drags the window
// and a double press maximises it.
type TitleBar struct {
	Title string
	// Badged shows the server's initial beside the name.
	Badged    bool
	OnAbout   func()
	AboutHint string
	// Left and Right are the room kept clear of the system's own window buttons.
	Left, Right float32
	// Controls draws minimise, maximise and close at the end; Maximized shows restore in place of maximise.
	Controls               bool
	Maximized              bool
	OnMinimize, OnMaximize func()
	OnClose                func()
	OnDrag, OnDoubleClick  func()

	name FitLine
}

func (t *TitleBar) Measure(*Context, float32) geom.Size { return geom.Size{H: TitleBarHeight} }

func (t *TitleBar) Draw(c *Context, r geom.Rect) {
	c.Paint.Fill(r, 0, c.Theme.Bg)
	edge := c.Hairline()
	c.Paint.Fill(geom.Rect{X: r.X, Y: r.Bottom() - edge, W: r.W, H: edge}, 0, c.Theme.Border)
	inner := geom.Rect{X: r.X, Y: r.Y, W: r.W, H: r.H - edge}

	top := inner.Y + (inner.H-barButtonH)/2
	right := inner.Right() - t.Right
	if t.Right == 0 {
		right -= barSidePad
	}
	if t.Controls {
		right = t.drawControls(c, inner)
	}
	t.button(c, geom.Rect{X: right - barButtonW, Y: top, W: barButtonW, H: barButtonH}, "info", true, t.OnAbout)

	t.drawTitle(c, inner)

	if hovered := c.Hovered(inner); hovered && !c.Claimed() {
		if c.In.Pressed {
			c.Claim()
			if c.In.Clicks == 2 && t.OnDoubleClick != nil {
				t.OnDoubleClick()
			} else if t.OnDrag != nil {
				t.OnDrag()
			}
		}
	}
}

func (t *TitleBar) button(c *Context, r geom.Rect, icon string, enabled bool, onClick func()) {
	ink := c.Theme.Muted
	if enabled && c.Hovered(r) {
		c.SetCursor(rl.MouseCursorPointingHand)
		c.Paint.Fill(r, barButtonR, theme.WithAlpha(c.Theme.Tint, barButtonHover))
		ink = c.Theme.Text
		if c.In.Pressed {
			c.Claim()
			if onClick != nil {
				onClick()
			}
		}
	}
	if !enabled {
		ink = theme.WithAlpha(ink, 0.35)
	}
	c.Paint.Icon(icon, geom.Rect{X: r.X + (r.W-barButtonIcon)/2, Y: r.Y + (r.H-barButtonIcon)/2, W: barButtonIcon, H: barButtonIcon}, ink)
}

// drawTitle centres the server at the middle of the window whatever is at the sides.
func (t *TitleBar) drawTitle(c *Context, r geom.Rect) {
	t.name.Content, t.name.Style, t.name.LineHeight = t.Title, barTitleStyle, r.H
	width := min(c.Paint.TextWidth(t.Title, barTitleStyle), r.W*barTitleMax)
	total := width
	if t.Badged {
		total += barBadge + barTitleGap
	}
	x := r.X + (r.W-total)/2
	if t.Badged {
		badge := geom.Rect{X: x, Y: r.Y + (r.H-barBadge)/2, W: barBadge, H: barBadge}
		c.Paint.Fill(badge, barBadgeR, theme.WithAlpha(c.Theme.Accent, chipBadgeAlpha))
		letter := initialM.of(t.Title)
		w := c.Paint.TextWidth(letter, barBadgeStyle)
		c.Paint.Text(letter, badge.X+(badge.W-w)/2, badge.Y, badge.H, barBadgeStyle, c.Theme.Text)
		x += barBadge + barTitleGap
	}
	t.name.Draw(c, geom.Rect{X: x, Y: r.Y, W: width, H: r.H})
}

// drawControls draws the window buttons at the end of the bar and returns where they begin.
func (t *TitleBar) drawControls(c *Context, r geom.Rect) float32 {
	x := r.Right() - 3*controlW
	t.control(c, geom.Rect{X: x, Y: r.Y, W: controlW, H: r.H}, 0, t.OnMinimize)
	t.control(c, geom.Rect{X: x + controlW, Y: r.Y, W: controlW, H: r.H}, 1, t.OnMaximize)
	t.control(c, geom.Rect{X: x + 2*controlW, Y: r.Y, W: controlW, H: r.H}, 2, t.OnClose)
	return x
}

func (t *TitleBar) control(c *Context, r geom.Rect, kind int, onClick func()) {
	ink := c.Theme.Text
	if c.Hovered(r) {
		fill := theme.WithAlpha(c.Theme.Tint, controlHover)
		if kind == 2 {
			fill, ink = closeHover, color.RGBA{255, 255, 255, 255}
		}
		c.Paint.Fill(r, 0, fill)
		if c.In.Pressed {
			c.Claim()
			if onClick != nil {
				onClick()
			}
		}
	}
	cx, cy := r.X+r.W/2, r.Y+r.H/2
	line := c.Hairline()
	half := float32(controlGlyph) / 2
	switch {
	case kind == 0:
		c.Paint.Fill(geom.Rect{X: cx - half, Y: cy, W: controlGlyph, H: line}, 0, ink)
	case kind == 1 && !t.Maximized:
		c.Paint.Stroke(geom.Rect{X: cx - half, Y: cy - half, W: controlGlyph, H: controlGlyph}, 0, line, ink)
	case kind == 1:
		back := geom.Rect{X: cx - half + 2, Y: cy - half, W: controlGlyph - 2, H: controlGlyph - 2}
		front := geom.Rect{X: cx - half, Y: cy - half + 2, W: controlGlyph - 2, H: controlGlyph - 2}
		c.Paint.Stroke(back, 0, line, ink)
		c.Paint.Fill(front, 0, closeFill(c, r))
		c.Paint.Stroke(front, 0, line, ink)
	default:
		c.Paint.Line(cx-half, cy-half, cx+half, cy+half, line*1.2, ink)
		c.Paint.Line(cx-half, cy+half, cx+half, cy-half, line*1.2, ink)
	}
}

// closeFill is what is behind a restore glyph's front square, so the back one shows only where it sticks out.
func closeFill(c *Context, r geom.Rect) color.RGBA {
	if c.Hovered(r) {
		return mixOver(c.Theme.Bg, c.Theme.Tint, controlHover)
	}
	return c.Theme.Bg
}

func mixOver(base, over color.RGBA, alpha float32) color.RGBA { return theme.Mix(base, over, alpha) }
