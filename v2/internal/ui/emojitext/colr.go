package emojitext

import (
	"image"
	"image/color"
	"image/draw"
	"math"

	"github.com/go-text/typesetting/font"
	"github.com/go-text/typesetting/font/opentype"
	"github.com/go-text/typesetting/font/opentype/tables"
	"golang.org/x/image/vector"
)

const colrPadding = 1

// layered draws COLR glyphs: stacked outlines, each in a palette colour. Gradients are flattened to their first colour and transforms are ignored.
type layered struct {
	face *font.Face
	colr *tables.COLR1
}

type canvas struct {
	layered *layered
	dst     *image.RGBA
	scale   float32
	originX float32
	originY float32
}

func (l *layered) bitmap(f *Font, gid font.GID, px float32) *Bitmap {
	scale := px / f.upem
	extents, _ := l.face.FontHExtents()
	advance := l.face.HorizontalAdvance(gid) * scale
	w, h := int(math.Ceil(float64(advance)))+2*colrPadding, int(math.Ceil(float64((extents.Ascender-extents.Descender)*scale)))+2*colrPadding
	c := &canvas{layered: l, dst: image.NewRGBA(image.Rect(0, 0, w, h)), scale: scale, originX: colrPadding, originY: extents.Ascender*scale + colrPadding}
	root, ok := l.colr.Search(tables.GlyphID(gid))
	if !ok {
		return nil
	}
	c.paint(root, nil)
	return &Bitmap{Pix: straight(c.dst), W: w, H: h, Left: -colrPadding, Top: -c.originY}
}

func (c *canvas) paint(t tables.PaintTable, mask *image.Alpha) {
	switch p := t.(type) {
	case tables.PaintColrLayersResolved:
		for _, layer := range p {
			c.fill(c.outline(font.GID(layer.GlyphID)), c.color(layer.PaletteIndex, 1))
		}
	case tables.PaintColrLayers:
		if layers, err := c.layered.colr.LayerList.Resolve(p); err == nil {
			for _, layer := range layers {
				c.paint(layer, mask)
			}
		}
	case tables.PaintGlyph:
		c.paint(p.Paint, c.outline(font.GID(p.GlyphID)))
	case tables.PaintColrGlyph:
		if inner, ok := c.layered.colr.Search(p.GlyphID); ok {
			c.paint(inner, mask)
		}
	case tables.PaintSolid:
		c.fill(mask, c.color(p.PaletteIndex, alpha(p.Alpha)))
	case tables.PaintLinearGradient:
		c.fill(mask, c.stop(p.ColorLine))
	case tables.PaintRadialGradient:
		c.fill(mask, c.stop(p.ColorLine))
	case tables.PaintSweepGradient:
		c.fill(mask, c.stop(p.ColorLine))
	}
}

func alpha(a tables.Fixed214) float32 { return float32(a) / (1 << 14) }

func (c *canvas) stop(line tables.ColorLine) color.NRGBA {
	if len(line.ColorStops) == 0 {
		return color.NRGBA{}
	}
	return c.color(line.ColorStops[0].PaletteIndex, alpha(line.ColorStops[0].Alpha))
}

func (c *canvas) color(index uint16, a float32) color.NRGBA {
	palette := c.layered.face.CPAL
	if len(palette) == 0 || int(index) >= len(palette[0]) {
		return color.NRGBA{}
	}
	rec := palette[0][index]
	return color.NRGBA{R: rec.Red, G: rec.Green, B: rec.Blue, A: uint8(float32(rec.Alpha)*a + 0.5)}
}

func (c *canvas) fill(mask *image.Alpha, col color.NRGBA) {
	if mask != nil {
		draw.DrawMask(c.dst, c.dst.Rect, image.NewUniform(col), image.Point{}, mask, image.Point{}, draw.Over)
	}
}

func (c *canvas) outline(gid font.GID) *image.Alpha {
	outline, ok := c.layered.face.GlyphDataOutline(gid)
	if !ok {
		return nil
	}
	rect := c.dst.Rect
	raster := vector.NewRasterizer(rect.Dx(), rect.Dy())
	point := func(p opentype.SegmentPoint) (float32, float32) {
		return c.originX + p.X*c.scale, c.originY - p.Y*c.scale
	}
	for _, seg := range outline.Segments {
		switch seg.Op {
		case opentype.SegmentOpMoveTo:
			raster.MoveTo(point(seg.Args[0]))
		case opentype.SegmentOpLineTo:
			raster.LineTo(point(seg.Args[0]))
		case opentype.SegmentOpQuadTo:
			ax, ay := point(seg.Args[0])
			bx, by := point(seg.Args[1])
			raster.QuadTo(ax, ay, bx, by)
		case opentype.SegmentOpCubeTo:
			ax, ay := point(seg.Args[0])
			bx, by := point(seg.Args[1])
			cx, cy := point(seg.Args[2])
			raster.CubeTo(ax, ay, bx, by, cx, cy)
		}
	}
	mask := image.NewAlpha(rect)
	raster.Draw(mask, rect, image.Opaque, image.Point{})
	return mask
}
