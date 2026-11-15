package widget

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	ghostNameSize  = 14
	ghostHintSize  = 12.48
	ghostGap       = 3.2
	ghostPad       = 8
	ghostFillAlpha = 0.03
	ghostLineAlpha = 0.22
	ghostHintAlpha = 0.6
	ghostHoverFill = 0.1
	ghostDash      = 3
)

// GhostTile holds the place of a stream that is being sent and is not being watched; pressing it opens the stream.
type GhostTile struct {
	Name string
	Hint string
}

// Show draws the tile and reports a press on it.
func (g GhostTile) Show(c *Context, r geom.Rect) bool {
	hovered := c.Hovered(r)
	line, fill := theme.WithAlpha(c.Theme.Tint, ghostLineAlpha), theme.WithAlpha(c.Theme.Tint, ghostFillAlpha)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
		line, fill = c.Theme.Accent, theme.WithAlpha(c.Theme.Accent, ghostHoverFill)
	}
	c.Paint.Fill(r, videoTileRadius, fill)
	c.Paint.DashedRoundRect(r, videoTileRadius, c.Hairline(), ghostDash, ghostDash, line)

	name := paint.TextStyle{Size: ghostNameSize, Weight: paint.Semibold}
	hint := paint.TextStyle{Size: ghostHintSize, Weight: paint.Regular}
	nameLine, hintLine := float32(ghostNameSize*1.5), float32(ghostHintSize*1.5)
	inner := r.InsetAll(ghostPad)
	top := r.Y + (r.H-nameLine-ghostGap-hintLine)/2
	c.Paint.TextIn(inner, g.Name, inner.X+max(0, (inner.W-c.Paint.TextWidth(g.Name, name))/2), top, nameLine, name, c.Theme.Text)
	c.Paint.TextIn(inner, g.Hint, inner.X+max(0, (inner.W-c.Paint.TextWidth(g.Hint, hint))/2), top+nameLine+ghostGap, hintLine, hint, theme.WithAlpha(c.Theme.Text, ghostHintAlpha))
	if hovered && c.In.Pressed {
		c.Claim()
		return true
	}
	return false
}
