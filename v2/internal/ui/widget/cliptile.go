package widget

import (
	"image/color"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/theme"
)

const (
	tilePadX     = 9.6
	tilePadY     = 8
	tileGap      = 6.4
	tileRadius   = 8
	tileTextSize = 13.6
	tileLine     = tileTextSize * 1.5
	tileEmoji    = 16
	tileRestA    = 0.05
	tileHoverA   = 0.12
	tileEdgeA    = 0.1
	tilePlayingA = 0.3
	tileFlash    = 350 * time.Millisecond
	tileEllipsis = "…"

	toolInset    = 2.4
	toolGap      = 1.6
	toolW        = 16.4
	toolH        = 13.6
	toolIcon     = 10.4
	toolRadius   = 4
	toolBackdrop = 0.6
	toolDisabled = 0.3

	keyPadX   = 4.8
	keyPadY   = 0.8
	keyRadius = 4
	keySize   = 9.92
	keyGap    = 6.4
)

var (
	tileStyle  = paint.TextStyle{Size: tileTextSize, Weight: paint.Regular}
	emojiStyle = paint.TextStyle{Size: tileEmoji, Weight: paint.Regular}
	keyStyle   = paint.TextStyle{Size: keySize, Weight: paint.Regular}
)

// ClipTool is one of the small buttons that appear over a tile while the pointer is on it.
type ClipTool struct {
	Icon     string
	Disabled bool
	OnClick  func()
}

// ClipTile is a button for one sound: its emoji and name. Pressing it flashes it for a moment.
type ClipTile struct {
	Emoji string
	Name  string
	Tools []ClipTool
	// Key is the hotkey that plays the clip, shown at the tile's far end.
	Key string
	// OnMenu is called with the pointer's position when the tile is right-clicked.
	OnMenu  func(x, y float32)
	OnClick func()

	flashUntil time.Time
	fitWidth   float32
	fitted     string
}

func (t *ClipTile) Measure(c *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: 2*(tilePadY+c.Hairline()) + tileLine}
}

// Flash lights the tile as pressed.
func (t *ClipTile) Flash() { t.flashUntil = time.Now().Add(tileFlash) }

func (t *ClipTile) Draw(c *Context, r geom.Rect) {
	hovered := c.Hovered(r)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	toolsHit := hovered && t.toolAt(c, r) >= 0
	fill, edge := theme.WithAlpha(c.Theme.Tint, tileRestA), theme.WithAlpha(c.Theme.Tint, tileEdgeA)
	switch {
	case t.flashing():
		fill, edge = theme.WithAlpha(c.Theme.Accent, tilePlayingA), c.Theme.Accent
	case hovered:
		fill = theme.WithAlpha(c.Theme.Tint, tileHoverA)
	}
	c.Paint.Fill(r, tileRadius, fill)
	c.Paint.Stroke(r, tileRadius, c.Hairline(), edge)

	inner := r.Inset(tilePadX+c.Hairline(), tilePadY+c.Hairline(), tilePadX+c.Hairline(), tilePadY+c.Hairline())
	x := inner.X
	if t.Emoji != "" {
		c.Paint.TextIn(geom.Rect{X: x, Y: inner.Y, W: tileEmoji + tileGap, H: tileLine}, t.Emoji, x, inner.Y+(tileLine-tileEmoji*1.2)/2, tileEmoji*1.2, emojiStyle, c.Theme.Text)
		x += c.Paint.TextWidth(t.Emoji, emojiStyle) + tileGap
	}
	right := inner.Right()
	if t.Key != "" {
		w := c.Paint.TextWidth(t.Key, keyStyle) + 2*(keyPadX+c.Hairline())
		h := keySize*1.5 + 2*(keyPadY+c.Hairline())
		box := geom.Rect{X: right - w, Y: inner.Y + (tileLine-h)/2, W: w, H: h}
		c.Paint.Fill(box, keyRadius, c.Theme.Bg)
		c.Paint.Stroke(box, keyRadius, c.Hairline(), c.Theme.BorderStrong)
		c.Paint.Text(t.Key, box.X+keyPadX+c.Hairline(), box.Y+keyPadY+c.Hairline(), keySize*1.5, keyStyle, c.Theme.Muted)
		right = box.X - keyGap
	}
	c.Paint.Text(t.fit(c, right-x), x, inner.Y, tileLine, tileStyle, c.Theme.Text)

	if hovered {
		t.drawTools(c, r)
		if c.In.RightPressed && t.OnMenu != nil {
			c.Claim()
			t.OnMenu(c.In.MouseX, c.In.MouseY)
		}
	}
	if hovered && c.In.Pressed && !toolsHit {
		c.Claim()
		t.Flash()
		if t.OnClick != nil {
			t.OnClick()
		}
	}
}

// toolRect is where the i-th of n tools sits: the row hangs from the tile's top right corner, the first tool leftmost.
func toolRect(r geom.Rect, i, n int) geom.Rect {
	return geom.Rect{X: r.Right() - toolInset - float32(n-i)*toolW - float32(n-i-1)*toolGap, Y: r.Y + toolInset, W: toolW, H: toolH}
}

// toolAt is the tool under the pointer, or -1.
func (t *ClipTile) toolAt(c *Context, r geom.Rect) int {
	for i := range t.Tools {
		if c.Hovered(toolRect(r, i, len(t.Tools))) {
			return i
		}
	}
	return -1
}

func (t *ClipTile) drawTools(c *Context, r geom.Rect) {
	for i, tool := range t.Tools {
		box := toolRect(r, i, len(t.Tools))
		fill, ink := color.RGBA{A: uint8(toolBackdrop * 255)}, c.Theme.Text
		over := !tool.Disabled && c.Hovered(box)
		if over {
			c.SetCursor(rl.MouseCursorPointingHand)
			fill = c.Theme.Accent
		}
		if tool.Disabled {
			fill, ink = theme.WithAlpha(fill, toolDisabled), theme.WithAlpha(ink, toolDisabled)
		}
		c.Paint.Fill(box, toolRadius, fill)
		c.Paint.Icon(tool.Icon, geom.Rect{X: box.X + (box.W-toolIcon)/2, Y: box.Y + (box.H-toolIcon)/2, W: toolIcon, H: toolIcon}, ink)
		if over && c.In.Pressed {
			c.Claim()
			if tool.OnClick != nil {
				tool.OnClick()
			}
		}
	}
}

func (t *ClipTile) flashing() bool {
	if t.flashUntil.IsZero() {
		return false
	}
	left := time.Until(t.flashUntil)
	if left <= 0 {
		t.flashUntil = time.Time{}
		return false
	}
	redraw.After(left)
	return true
}

// fit is the name cut with an ellipsis to the width, remembered until the width changes.
func (t *ClipTile) fit(c *Context, width float32) string {
	if t.fitted != "" && t.fitWidth == width {
		return t.fitted
	}
	t.fitWidth, t.fitted = width, t.Name
	if c.Paint.TextWidth(t.Name, tileStyle) <= width {
		return t.fitted
	}
	runes := []rune(t.Name)
	for n := len(runes) - 1; n > 0; n-- {
		if candidate := string(runes[:n]) + tileEllipsis; c.Paint.TextWidth(candidate, tileStyle) <= width {
			t.fitted = candidate
			return t.fitted
		}
	}
	t.fitted = tileEllipsis
	return t.fitted
}
