package paint

import (
	"image/color"
	"math"

	rl "github.com/gen2brain/raylib-go/raylib"
	"github.com/go-text/typesetting/font"

	"harmony/v2/internal/ui/emojitext"
)

// lookupColor is lookup for colour glyphs: their pixels go in the same pages, with the glyph's own colours instead of white.
func (a *atlas) lookupColor(f *emojitext.Font, id font.GID, physicalSize float32) *bitmap {
	key := glyphKey{f.Face(), id, int32(math.Round(float64(physicalSize * sizeQuantum))), 0}
	if b, ok := a.glyphs[key]; ok {
		return b
	}
	b := a.uploadColor(f.Bitmap(id, float32(key.size)/sizeQuantum))
	a.glyphs[key] = b
	return b
}

func (a *atlas) uploadColor(img *emojitext.Bitmap) *bitmap {
	if img == nil {
		return &bitmap{page: -1}
	}
	page, x, y := a.allocate(img.W, img.H)
	rl.UpdateTextureRec(a.pages[page], rl.Rectangle{X: float32(x), Y: float32(y), Width: float32(img.W), Height: float32(img.H)}, img.Pix)
	return a.place(page, x, y, img.W, img.H, img.Left, img.Top)
}

func (p *Painter) drawEmoji(r *run, originX, originY, size float64, c color.RGBA) {
	if len(r.emoji) == 0 {
		return
	}
	scale := float64(p.Zoom * p.dpi)
	tint := color.RGBA{255, 255, 255, c.A}
	for _, g := range r.emoji {
		b := p.atlas.lookupColor(p.shaper.emoji, g.id, float32(size*scale))
		if b.page < 0 {
			continue
		}
		gx := math.Round(originX+float64(g.x)*scale) + float64(b.left)
		gy := originY + float64(b.top)
		x0, y0 := float32(gx)/p.dpi, float32(gy)/p.dpi
		p.texturedQuad(b.texture, x0, y0, x0+b.w/p.dpi, y0+b.h/p.dpi, b.u0, b.v0, b.u1, b.v1, false, tint)
	}
}
