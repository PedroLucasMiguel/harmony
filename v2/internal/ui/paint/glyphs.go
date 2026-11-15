package paint

import (
	"image"
	"image/color"
	"math"

	rl "github.com/gen2brain/raylib-go/raylib"
	"github.com/go-text/typesetting/font"
	"github.com/go-text/typesetting/font/opentype"
	"golang.org/x/image/vector"
)

const coverageGamma = 0.4

var coverageCurve = func() (table [256]uint8) {
	for i := range table {
		table[i] = uint8(math.Pow(float64(i)/255, coverageGamma)*255 + 0.5)
	}
	return table
}()

const (
	atlasSize    = 1024
	atlasPadding = 1
	sizeQuantum  = 8
	whiteSize    = 2
)

type glyphKey struct {
	face *font.Face
	id   font.GID
	size int32
}

type bitmap struct {
	page           int
	texture        uint32
	x, y, w, h     float32
	left, top      float32
	u0, v0, u1, v1 float32
}

func (a *atlas) place(page, x, y, w, h int, left, top float32) *bitmap {
	b := &bitmap{page: page, texture: a.pages[page].ID, x: float32(x), y: float32(y), w: float32(w), h: float32(h), left: left, top: top}
	b.u0, b.v0, b.u1, b.v1 = b.x/atlasSize, b.y/atlasSize, (b.x+b.w)/atlasSize, (b.y+b.h)/atlasSize
	return b
}

// solidTexture is the page whose white block flat shapes sample: the one the batch is already drawing with, if it is a page.
func (a *atlas) solidTexture(current uint32) uint32 {
	if len(a.pages) == 0 {
		a.newPage()
	}
	for _, page := range a.pages {
		if page.ID == current {
			return current
		}
	}
	return a.pages[0].ID
}

type atlas struct {
	pages     []rl.Texture2D
	cursorX   int
	cursorY   int
	rowHeight int
	glyphs    map[glyphKey]*bitmap
	pending   []color.RGBA
}

func newAtlas() *atlas { return &atlas{glyphs: map[glyphKey]*bitmap{}} }

func (a *atlas) close() {
	for _, page := range a.pages {
		rl.UnloadTexture(page)
	}
}

func (a *atlas) lookup(face *font.Face, id font.GID, physicalSize float32) *bitmap {
	key := glyphKey{face, id, int32(math.Round(float64(physicalSize * sizeQuantum)))}
	if b, ok := a.glyphs[key]; ok {
		return b
	}
	b := a.render(face, id, float32(key.size)/sizeQuantum)
	a.glyphs[key] = b
	return b
}

func (a *atlas) render(face *font.Face, id font.GID, size float32) *bitmap {
	outline, ok := face.GlyphDataOutline(id)
	if !ok || len(outline.Segments) == 0 {
		return &bitmap{page: -1}
	}
	scale := size / float32(face.Upem())
	minX, minY, maxX, maxY := bounds(outline, scale)
	left, top := int(math.Floor(float64(minX))), int(math.Floor(float64(minY)))
	w, h := int(math.Ceil(float64(maxX)))-left+1, int(math.Ceil(float64(maxY)))-top+1

	raster := vector.NewRasterizer(w, h)
	point := func(p opentype.SegmentPoint) (float32, float32) {
		return p.X*scale - float32(left), -p.Y*scale - float32(top)
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
	coverage := image.NewAlpha(image.Rect(0, 0, w, h))
	raster.Draw(coverage, coverage.Bounds(), image.Opaque, image.Point{})

	page, x, y := a.allocate(w, h)
	pixels := make([]color.RGBA, w*h)
	for i := 0; i < w*h; i++ {
		pixels[i] = color.RGBA{255, 255, 255, coverageCurve[coverage.Pix[i]]}
	}
	rl.UpdateTextureRec(a.pages[page], rl.Rectangle{X: float32(x), Y: float32(y), Width: float32(w), Height: float32(h)}, pixels)
	return a.place(page, x, y, w, h, float32(left), float32(top))
}

func bounds(outline font.GlyphOutline, scale float32) (minX, minY, maxX, maxY float32) {
	minX, minY = math.MaxFloat32, math.MaxFloat32
	maxX, maxY = -math.MaxFloat32, -math.MaxFloat32
	for _, seg := range outline.Segments {
		n := map[opentype.SegmentOp]int{opentype.SegmentOpMoveTo: 1, opentype.SegmentOpLineTo: 1, opentype.SegmentOpQuadTo: 2, opentype.SegmentOpCubeTo: 3}[seg.Op]
		for _, p := range seg.Args[:n] {
			x, y := p.X*scale, -p.Y*scale
			minX, maxX = min(minX, x), max(maxX, x)
			minY, maxY = min(minY, y), max(maxY, y)
		}
	}
	return minX, minY, maxX, maxY
}

func (a *atlas) allocate(w, h int) (page, x, y int) {
	w, h = w+atlasPadding, h+atlasPadding
	if len(a.pages) == 0 || a.cursorX+w > atlasSize {
		a.cursorX, a.cursorY, a.rowHeight = 0, a.cursorY+a.rowHeight, 0
	}
	if len(a.pages) == 0 || a.cursorY+h > atlasSize {
		a.newPage()
	}
	x, y = a.cursorX, a.cursorY
	a.cursorX += w
	a.rowHeight = max(a.rowHeight, h)
	return len(a.pages) - 1, x, y
}

func (a *atlas) newPage() {
	blank := rl.GenImageColor(atlasSize, atlasSize, color.RGBA{255, 255, 255, 0})
	texture := rl.LoadTextureFromImage(blank)
	rl.UnloadImage(blank)
	rl.SetTextureFilter(texture, rl.FilterBilinear)
	a.pages = append(a.pages, texture)
	white := [whiteSize * whiteSize]color.RGBA{{255, 255, 255, 255}, {255, 255, 255, 255}, {255, 255, 255, 255}, {255, 255, 255, 255}}
	rl.UpdateTextureRec(texture, rl.Rectangle{Width: whiteSize, Height: whiteSize}, white[:])
	a.cursorX, a.cursorY, a.rowHeight = whiteSize+atlasPadding, 0, whiteSize+atlasPadding
}
