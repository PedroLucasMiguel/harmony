package widget

import (
	"image/color"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

type ServerStatus int

const (
	ServerUnknown ServerStatus = iota
	ServerUp
	ServerChecking
)

type ServerChip struct {
	Name    string
	Host    string
	Status  ServerStatus
	Menu    *ServerMenu
	OnClick func()
}

const (
	chipPaddingY   = 8
	chipPaddingR   = 10
	chipPaddingL   = 12
	chipGap        = 10
	chipBadge      = 30
	chipBadgeR     = 8
	chipDot        = 10
	chipTextLine   = 1.25
	chipNameSize   = 14
	chipHostSize   = 12
	chipCaretSize  = 12
	chipBadgeAlpha = 0.22
	chipTextHeight = chipNameSize*chipTextLine + chipHostSize*chipTextLine
)

func (s *ServerChip) Measure(c *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: 2*chipPaddingY + chipTextHeight + 2*c.Hairline()}
}

func (s *ServerChip) Draw(c *Context, r geom.Rect) {
	hovered := c.Hovered(r)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	if c.Clicked(r) {
		c.Claim()
		if s.Menu != nil {
			s.Menu.Toggle()
		}
		if s.OnClick != nil {
			s.OnClick()
		}
	}
	if s.Menu != nil {
		s.Menu.Show(c, r)
	}
	edge := c.Theme.Border
	switch {
	case s.Menu != nil && s.Menu.Open():
		edge = c.Theme.Accent
	case hovered:
		edge = c.Theme.BorderStrong
	}
	c.Paint.Fill(r, c.Theme.Radius, c.Theme.Surface2)
	c.Paint.Stroke(r, c.Theme.Radius, c.Hairline(), edge)

	inner := r.InsetAll(c.Hairline())
	badge := geom.Rect{X: inner.X + chipPaddingL, Y: inner.Y + (inner.H-chipBadge)/2, W: chipBadge, H: chipBadge}
	s.drawBadge(c, badge)

	textX := badge.Right() + chipGap
	maxText := inner.Right() - chipPaddingR - chipCaretSize - chipGap - textX
	nameStyle := paint.TextStyle{Size: chipNameSize, Weight: paint.Semibold}
	hostStyle := paint.TextStyle{Size: chipHostSize, Weight: paint.Regular}
	nameLine, hostLine := float32(chipNameSize*chipTextLine), float32(chipHostSize*chipTextLine)
	top := inner.Y + (inner.H-nameLine-hostLine)/2
	c.Paint.PushClip(geom.Rect{X: textX, Y: inner.Y, W: maxText, H: inner.H})
	c.Paint.Text(s.Name, textX, top, nameLine, nameStyle, c.Theme.Text)
	c.Paint.Text(s.Host, textX, top+nameLine, hostLine, hostStyle, c.Theme.Muted)
	c.Paint.PopClip()

	cx, cy := inner.Right()-chipPaddingR-chipCaretSize/2, inner.Y+inner.H/2
	c.Paint.Triangle([2]float32{cx - 2.5, cy - 1.4}, [2]float32{cx, cy + 1.8}, [2]float32{cx + 2.5, cy - 1.4}, c.Theme.Muted)
}

func (s *ServerChip) drawBadge(c *Context, badge geom.Rect) {
	drawServerBadge(c, badge, s.Name, s.Status)
}

func statusColor(c *Context, status ServerStatus) color.RGBA {
	switch status {
	case ServerUp:
		return c.Theme.Live
	case ServerChecking:
		return c.Theme.Warn
	}
	return c.Theme.Muted
}

// drawServerBadge is a server's initial on a tinted square, with a dot for whether it answers.
func drawServerBadge(c *Context, badge geom.Rect, name string, status ServerStatus) {
	ServerBadge(c, badge, name)

	dotX, dotY := badge.Right()+2-chipDot/2, badge.Bottom()+2-chipDot/2
	c.Paint.Circle(dotX, dotY, chipDot/2+2, c.Theme.Surface2)
	c.Paint.Circle(dotX, dotY, chipDot/2, statusColor(c, status))
}

func firstLetter(name string) string {
	for _, r := range name {
		return string(r)
	}
	return ""
}

// ServerBadge is a server's initial on a tinted square.
func ServerBadge(c *Context, badge geom.Rect, name string) {
	c.Paint.Fill(badge, chipBadgeR, theme.WithAlpha(c.Theme.Accent, chipBadgeAlpha))
	style := paint.TextStyle{Size: chipNameSize, Weight: paint.Bold}
	initial := initialM.of(name)
	width := c.Paint.TextWidth(initial, style)
	line := float32(chipNameSize * 1.5)
	c.Paint.Text(initial, badge.X+(badge.W-width)/2, badge.Y+(badge.H-line)/2, line, style, c.Theme.Text)
}
