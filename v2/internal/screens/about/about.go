// Package about is the About Harmony window: who made it, who it owes, what it is built on and the version to give when something is reported.
package about

import (
	"image/color"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
	"harmony/v2/internal/version"
)

const (
	backdrop    = 140
	cardWidth   = 480
	cardMargin  = 24
	padX        = 19.2
	padY        = 17.6
	radius      = 10
	buttonTop   = 12.8
	buttonGap   = 8
	maxShare    = 0.9
	cardEdgeTin = 0.14
)

const (
	authorURL  = "https://github.com/PedroLucasMiguel"
	sourceURL  = "https://github.com/PedroLucasMiguel/harmony"
	cirandaURL = "https://github.com/Brunovncs/ciranda"
	brunoURL   = "https://github.com/Brunovncs"
)

type credit struct{ name, url, note string }

var builtOn = []credit{
	{"raylib", "https://www.raylib.com/", ""},
	{"Pion", "https://github.com/pion/webrtc", "(MIT)"},
	{"MediaMTX", "https://github.com/bluenviron/mediamtx", ""},
	{"RNNoise", "https://github.com/xiph/rnnoise", "(BSD)"},
	{"gopus", "https://github.com/thesyncim/gopus", ""},
	{"go-text", "https://github.com/go-text/typesetting", "(BSD)"},
	{"yt-dlp", "https://github.com/yt-dlp/yt-dlp", "optional"},
	{"Phosphor Icons", "https://phosphoricons.com/", "(MIT)"},
}

// Window is the About dialog; give it to OpenModal.
type Window struct {
	copied bool
	scroll widget.Scroll
	body   widget.Component
	copy   widget.Button
	built  *widget.Context
}

func New() *Window { return &Window{} }

func (w *Window) Draw(c *widget.Context, bounds geom.Rect) {
	c.Paint.Fill(bounds, 0, color.RGBA{A: backdrop})
	if w.built != c {
		w.build(c)
	}
	w.copy.Label = c.T("about.copy")
	if w.copied {
		w.copy.Label = c.T("about.copied")
	}
	width := min(cardWidth, bounds.W-2*cardMargin)
	edge := c.Hairline()
	inner := width - 2*(padX+edge)
	height := min(w.body.Measure(c, inner).H+2*(padY+edge), bounds.H*maxShare)
	card := geom.Rect{X: bounds.X + (bounds.W-width)/2, Y: bounds.Y + (bounds.H-height)/2, W: width, H: height}

	c.Layer(w)
	if c.Clicked(bounds) && !c.Hovered(card) || c.EscapeFor(w) {
		c.Claim()
		c.CloseModal()
		return
	}
	c.Paint.Fill(card, radius, c.Theme.Surface2)
	c.Paint.Stroke(card, radius, edge, theme.WithAlpha(c.Theme.Tint, cardEdgeTin))
	w.scroll.Child = w.body
	w.scroll.Draw(c, card.Inset(padX+edge, padY+edge, padX+edge, padY+edge))
}

func (w *Window) build(c *widget.Context) {
	w.built = c
	w.scroll.Bar = true
	w.scroll.ScrollBy(1e6)
	w.copy = widget.Button{Variant: widget.Ghost, OnClick: func() {
		rl.SetClipboardText(version.Report())
		w.copied = true
	}}
	closer := &widget.Button{Label: c.T("about.close"), Variant: widget.Primary, OnClick: c.CloseModal}
	made := &inline{parts: []part{{text: "Pedro Lucas Miguel", url: authorURL}, {text: " " + c.T("about.made_with_ai"), muted: true}}}
	source := &inline{parts: []part{{text: c.T("about.source"), url: sourceURL}}}
	thanks := &inline{parts: []part{
		{text: "Ciranda", url: cirandaURL}, {text: ","}, {text: " " + c.T("about.ciranda_by") + " "},
		{text: "Bruno (Brunovncs)", url: brunoURL}, {text: ":"}, {text: " " + c.T("about.ciranda_what"), muted: true},
	}}
	list := &flowList{}
	for _, b := range builtOn {
		parts := []part{{text: b.name, url: b.url}}
		switch b.note {
		case "":
		case "optional":
			parts = append(parts, part{text: " " + c.T("about.optional"), muted: true})
		default:
			parts = append(parts, part{text: " " + b.note, muted: true})
		}
		list.items = append(list.items, &inline{parts: parts})
	}
	license := &widget.Text{Content: c.T("about.license_text"), Wrap: true, Style: bodyStyle, LineHeight: bodyLine}
	w.body = widget.Col(0,
		head{version: version.String(), tagline: c.T("about.tagline")},
		section{title: c.T("about.made_by"), body: widget.Col(0, made, source)},
		section{title: c.T("about.credits"), body: thanks},
		section{title: c.T("about.built_on"), body: list},
		section{title: c.T("about.license"), body: license, last: true},
		widget.Padded{Top: buttonTop, Child: &widget.Row{Gap: buttonGap, Items: []widget.RowItem{widget.Grow(widget.Spacer{}), widget.Fixed(&w.copy), widget.Fixed(closer)}}},
	)
}

var bodyStyle = paint.TextStyle{Size: bodySize, Weight: paint.Regular}
