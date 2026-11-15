package widget

import (
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

type BannerKind int

const (
	ErrorBanner BannerKind = iota
	HintBanner
)

type Banner struct {
	Kind    BannerKind
	Content string
}

const (
	bannerRadius  = 8
	bannerSize    = 13
	errorPaddingY = 9
	errorPaddingX = 12
	hintPaddingY  = 12
	hintPaddingX  = 14
)

func (b Banner) padding() (y, x float32) {
	if b.Kind == HintBanner {
		return hintPaddingY, hintPaddingX
	}
	return errorPaddingY, errorPaddingX
}

func (b Banner) text() *Text {
	tone, lineHeight := ToneDanger, float32(bannerSize*1.5)
	if b.Kind == HintBanner {
		tone, lineHeight = ToneText, bannerSize*1.45
	}
	return &Text{Content: b.Content, Style: paint.TextStyle{Size: bannerSize, Weight: paint.Regular}, Tone: tone, LineHeight: lineHeight, Wrap: true}
}

func (b Banner) Measure(c *Context, maxWidth float32) geom.Size {
	y, x := b.padding()
	inner := b.text().Measure(c, maxWidth-2*x-2*c.Hairline())
	return geom.Size{W: maxWidth, H: inner.H + 2*y + 2*c.Hairline()}
}

func (b Banner) Draw(c *Context, r geom.Rect) {
	base := c.Theme.Danger
	fill, line := 0.1, 0.3
	if b.Kind == HintBanner {
		base, fill, line = c.Theme.Accent, 0.08, 0.35
	} else {
		base = c.Theme.DangerSoft
	}
	c.Paint.Fill(r, bannerRadius, theme.WithAlpha(base, float32(fill)))
	c.Paint.Stroke(r, bannerRadius, c.Hairline(), theme.WithAlpha(base, float32(line)))
	y, x := b.padding()
	b.text().Draw(c, r.Inset(x+c.Hairline(), y+c.Hairline(), x+c.Hairline(), y+c.Hairline()))
}
