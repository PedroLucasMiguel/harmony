package widget

import (
	"image/color"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	windowBackdrop      = 140
	windowWidthMin      = 768
	windowWidthShare    = 0.7
	windowWidthMax      = 1248
	windowWidthCap      = 0.94
	windowHeightMin     = 576
	windowHeightShare   = 0.85
	windowHeightMax     = 960
	windowHeightCap     = 0.92
	windowEdgeAlpha     = 0.14
	windowRadius        = 10
	windowNavMin        = 200
	windowNavShare      = 0.2
	windowNavMax        = 240
	windowNavPadX       = 11.2
	windowNavPadY       = 17.6
	windowNavGap        = 3.2
	windowNavTitleX     = 9.6
	windowNavTitleSize  = 16.8
	windowNavTitleLine  = 23.4
	windowNavTitleGap   = 17
	windowPagePadX      = 20.8
	windowPagePadTop    = 17.6
	windowPagePadBottom = 6.4
	windowFooterPadY    = 12
	windowFooterPadX    = 20.8
	windowNoteSize      = 13.6
	windowNoteGap       = 12
)

// SettingsWindow is the frame of a settings dialog: a menu of pages down the left, the page beside it in a scroll, and a footer with a
// quiet line on the left and the Done button on the right.
type SettingsWindow struct {
	Title string
	Nav   []NavItem
	// Note is the line in the footer, in the warning colour when NoteError is set.
	Note      string
	NoteError bool
	Done      Button
	Scroll    Scroll
}

// Draw draws the window over bounds with body as the page; the page scrolls on its own.
func (w *SettingsWindow) Draw(c *Context, bounds geom.Rect, body Component) {
	c.Paint.Fill(bounds, 0, color.RGBA{A: windowBackdrop})

	edge := c.Hairline()
	card := windowCard(bounds)
	c.Paint.Fill(card, windowRadius, c.Theme.Surface2)
	inner := card.InsetAll(edge)
	nav := geom.Rect{X: inner.X, Y: inner.Y, W: min(max(inner.W*windowNavShare, windowNavMin), windowNavMax), H: inner.H}
	w.drawNav(c, nav)
	c.Paint.Stroke(card, windowRadius, edge, theme.WithAlpha(c.Theme.Tint, windowEdgeAlpha))

	main := geom.Rect{X: nav.Right(), Y: inner.Y, W: inner.W - nav.W, H: inner.H}
	footer := w.drawFooter(c, main)
	w.Scroll.Child = body
	w.Scroll.Bar = true
	w.Scroll.Draw(c, geom.Rect{X: main.X, Y: main.Y, W: main.W, H: footer.Y - main.Y})
}

// PagePadding wraps a page's content in the window's own margins.
func (w *SettingsWindow) PagePadding(child Component) Component {
	return Padded{Left: windowPagePadX, Top: windowPagePadTop, Right: windowPagePadX, Bottom: windowPagePadBottom, Child: child}
}

// PageHeight is the height of the area a page has inside the window, less the window's own margins: what a page that fills the
// window (a list beside an editor) can take.
func (w *SettingsWindow) PageHeight(c *Context) float32 {
	card := windowCard(geom.Rect{W: c.Viewport.W, H: c.Viewport.H})
	footer := w.Done.Measure(c, 0).H + 2*windowFooterPadY + c.Hairline()
	return card.H - 2*c.Hairline() - footer - windowPagePadTop - windowPagePadBottom
}

func windowCard(bounds geom.Rect) geom.Rect {
	w := min(min(max(bounds.W*windowWidthShare, windowWidthMin), windowWidthMax), bounds.W*windowWidthCap)
	h := min(min(max(bounds.H*windowHeightShare, windowHeightMin), windowHeightMax), bounds.H*windowHeightCap)
	return geom.Rect{X: bounds.X + (bounds.W-w)/2, Y: bounds.Y + (bounds.H-h)/2, W: w, H: h}
}

func (w *SettingsWindow) drawNav(c *Context, nav geom.Rect) {
	c.Paint.Fill(nav, windowRadius, c.Theme.Surface)
	c.Paint.Fill(geom.Rect{X: nav.X + windowRadius, Y: nav.Y, W: nav.W - windowRadius, H: nav.H}, 0, c.Theme.Surface)
	c.Paint.Fill(geom.Rect{X: nav.Right() - c.Hairline(), Y: nav.Y, W: c.Hairline(), H: nav.H}, 0, c.Theme.Border)

	x, width := nav.X+windowNavPadX, nav.W-2*windowNavPadX-c.Hairline()
	y := nav.Y + windowNavPadY
	c.Paint.Text(w.Title, x+windowNavTitleX, y, windowNavTitleLine, paint.TextStyle{Size: windowNavTitleSize, Weight: paint.Semibold}, c.Theme.Text)
	y += windowNavTitleLine + windowNavTitleGap
	for _, item := range w.Nav {
		h := item.Measure(c, width).H
		item.Draw(c, geom.Rect{X: x, Y: y, W: width, H: h})
		y += h + windowNavGap
	}
}

// drawFooter draws the line, the note and the Done button along the bottom of main and returns the footer's area.
func (w *SettingsWindow) drawFooter(c *Context, main geom.Rect) geom.Rect {
	size := w.Done.Measure(c, 0)
	footer := geom.Rect{X: main.X, Y: main.Bottom() - size.H - 2*windowFooterPadY, W: main.W, H: size.H + 2*windowFooterPadY}
	c.Paint.Fill(geom.Rect{X: footer.X, Y: footer.Y - c.Hairline(), W: footer.W, H: c.Hairline()}, 0, c.Theme.Border)
	w.Done.Draw(c, geom.Rect{X: footer.Right() - windowFooterPadX - size.W, Y: footer.Y + windowFooterPadY, W: size.W, H: size.H})
	if w.Note != "" {
		tone := ToneMuted
		if w.NoteError {
			tone = ToneDangerSoft
		}
		style := paint.TextStyle{Size: windowNoteSize, Weight: paint.Regular}
		width := footer.W - 2*windowFooterPadX - size.W - windowNoteGap
		c.Paint.TextIn(geom.Rect{X: footer.X + windowFooterPadX, Y: footer.Y, W: width, H: footer.H}, w.Note, footer.X+windowFooterPadX, footer.Y+(footer.H-windowNoteSize*1.5)/2, windowNoteSize*1.5, style, tone.Color(c.Theme))
	}
	footer.Y -= c.Hairline()
	return footer
}
