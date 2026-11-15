package widget

import (
	"image/color"
	"math"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	callBarPadX       = 12
	callBarPadY       = 4
	callBarGap        = 8
	callBarDot        = 8
	callBarFont       = 13
	callBarButtonW    = 34
	callBarButtonH    = 30
	callBarIcon       = 18
	callBarRadius     = 8
	callBarLiveAlpha  = 0.18
	callBarEdgeAlpha  = 0.5
	callBarTintAlpha  = 0.06
	callBarOnAlpha    = 0.25
	callBarSlash      = 22
	callBarWherePad   = 4
	callBarSlashWidth = 2
)

// CallBar is the strip above everything while a call is on a server that is not the one on screen: where it is, and its controls.
type CallBar struct {
	// Where is what the call is: its channel and server; Return is what pressing it says, as a tooltip would.
	Where string
	// Connecting dims the bar while the connection is being dialled again.
	Connecting      bool
	Muted, Deafened bool
	OnReturn        func()
	OnMute          func()
	OnDeafen        func()
	OnLeave         func()
}

// Height is how tall the bar is, border included.
func (b *CallBar) Height(c *Context) float32 { return 2*callBarPadY + callBarButtonH + c.Hairline() }

func (b *CallBar) Draw(c *Context, r geom.Rect) {
	p, th := c.Paint, c.Theme
	fill, edge, dot := theme.WithAlpha(th.Live, callBarLiveAlpha), theme.WithAlpha(th.Live, callBarEdgeAlpha), th.Live
	if b.Connecting {
		fill, edge, dot = theme.WithAlpha(th.Tint, callBarTintAlpha), th.BorderStrong, th.Warn
	}
	p.Fill(r, 0, fill)
	p.Fill(geom.Rect{X: r.X, Y: r.Bottom() - c.Hairline(), W: r.W, H: c.Hairline()}, 0, edge)

	y := r.Y + callBarPadY
	x := r.Right() - callBarPadX
	leave := geom.Rect{X: x - callBarButtonW, Y: y, W: callBarButtonW, H: callBarButtonH}
	deafen := geom.Rect{X: leave.X - callBarGap - callBarButtonW, Y: y, W: callBarButtonW, H: callBarButtonH}
	mute := geom.Rect{X: deafen.X - callBarGap - callBarButtonW, Y: y, W: callBarButtonW, H: callBarButtonH}
	icon := "microphone"
	if b.Muted {
		icon = "microphone-slash"
	}
	b.button(c, mute, icon, b.Muted, false, b.OnMute)
	b.button(c, deafen, "headphones", b.Deafened, b.Deafened, b.OnDeafen)
	b.button(c, leave, "phone-disconnect", false, false, b.OnLeave)

	dotRect := geom.Rect{X: r.X + callBarPadX, Y: y + (callBarButtonH-callBarDot)/2, W: callBarDot, H: callBarDot}
	p.Fill(dotRect, callBarDot/2, dot)
	where := geom.Rect{X: dotRect.Right() + callBarGap, Y: y, W: mute.X - callBarGap - dotRect.Right() - callBarGap, H: callBarButtonH}
	style := paint.TextStyle{Size: callBarFont, Weight: paint.Regular}
	line := float32(callBarFont * 1.5)
	hovered := c.Hovered(where)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(where) {
			c.Claim()
			if b.OnReturn != nil {
				b.OnReturn()
			}
		}
	}
	text := geom.Rect{X: where.X + callBarWherePad, Y: where.Y + (where.H-line)/2, W: where.W - 2*callBarWherePad, H: line}
	p.TextIn(text, b.Where, text.X, text.Y, line, style, th.Text)
	if hovered {
		width := min(p.TextWidth(b.Where, style), text.W)
		p.Fill(geom.Rect{X: text.X, Y: text.Y + line - 3, W: width, H: c.Hairline()}, 0, th.Text)
	}
}

// button is a plate with an icon; on lights it as something that is switched on (muted, deafened), slashed for the headphones.
func (b *CallBar) button(c *Context, r geom.Rect, icon string, on, slashed bool, click func()) {
	p, th := c.Paint, c.Theme
	hovered := c.Hovered(r)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	ink := th.Text
	p.Fill(r, callBarRadius, th.Surface2)
	if on {
		p.Fill(r, callBarRadius, theme.WithAlpha(th.Danger, callBarOnAlpha))
		ink = th.DangerSoft
	}
	p.Stroke(r, callBarRadius, c.Hairline(), th.Border)
	glyph := geom.Rect{X: r.X + (r.W-callBarIcon)/2, Y: r.Y + (r.H-callBarIcon)/2, W: callBarIcon, H: callBarIcon}
	p.Icon(icon, glyph, ink)
	if slashed {
		cx, cy := glyph.X+glyph.W/2, glyph.Y+glyph.H/2
		dx, dy := float32(callBarSlash/2*math.Cos(math.Pi/4)), float32(callBarSlash/2*math.Sin(math.Pi/4))
		p.Line(cx-dx, cy-dy, cx+dx, cy+dy, callBarSlashWidth+2, color.RGBA{A: 115})
		p.Line(cx-dx, cy-dy, cx+dx, cy+dy, callBarSlashWidth, ink)
	}
	if hovered && c.Clicked(r) {
		c.Claim()
		if click != nil {
			click()
		}
	}
}
