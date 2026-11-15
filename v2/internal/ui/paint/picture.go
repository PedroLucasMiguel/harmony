package paint

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"math"
	"sync"
	"unsafe"

	rl "github.com/gen2brain/raylib-go/raylib"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/redraw"
)

const (
	pictureMaxEdge     = 1280
	pictureMaxPixels   = 48 << 20
	pictureBudgetBytes = 160 << 20
	pictureFetchers    = 4
	cornerSteps        = 6
)

type PictureState int32

const (
	PictureLoading PictureState = iota
	PictureReady
	PictureFailed
)

// Picture is an image fetched and decoded off the UI thread, uploaded to the GPU the first time it is drawn.
type Picture struct {
	mu      sync.Mutex
	state   PictureState
	w, h    int
	pending *image.NRGBA
	tex     rl.Texture2D
	live    bool
	used    uint64
	anim    *animation
}

// Size is the picture's natural size in pixels once it is known.
func (pic *Picture) Size() (w, h int, ok bool) {
	pic.mu.Lock()
	defer pic.mu.Unlock()
	return pic.w, pic.h, pic.state == PictureReady
}

func (pic *Picture) State() PictureState {
	pic.mu.Lock()
	defer pic.mu.Unlock()
	return pic.state
}

type pictures struct {
	mu    sync.Mutex
	items map[picKey]*Picture
	slots chan struct{}
	tick  uint64
	bytes int
}

func newPictures() *pictures {
	return &pictures{items: map[picKey]*Picture{}, slots: make(chan struct{}, pictureFetchers)}
}

// Picture returns the image stored under key, starting to fetch it with fetch the first time it is asked for.
func (p *Painter) Picture(key string, fetch func() ([]byte, error)) *Picture {
	ps := p.pictures
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if pic, ok := ps.items[picKey{key: key}]; ok {
		return pic
	}
	pic := &Picture{}
	ps.items[picKey{key: key}] = pic
	go ps.load(pic, func() (*image.NRGBA, int, int, error) {
		data, err := fetch()
		if err != nil {
			return nil, 0, 0, err
		}
		if a, first, w, h := decodeAnimation(data); a != nil {
			pic.mu.Lock()
			pic.anim = a
			pic.mu.Unlock()
			return first, w, h, nil
		}
		return decodePicture(data)
	})
	return pic
}

// Source is where images come from: Bytes is the function that fetches the one stored under a hash.
type Source interface {
	Bytes(hash string) func() ([]byte, error)
}

// PictureFrom is Picture for an image from src, which makes the fetch function only when the image is first asked for.
func (p *Painter) PictureFrom(key string, src Source) *Picture {
	if pic := p.PeekPicture(key); pic != nil {
		return pic
	}
	return p.Picture(key, src.Bytes(key))
}

// PeekPicture is Picture without starting a fetch: nil when the image has not been asked for.
func (p *Painter) PeekPicture(key string) *Picture {
	p.pictures.mu.Lock()
	defer p.pictures.mu.Unlock()
	return p.pictures.items[picKey{key: key}]
}

func (ps *pictures) load(pic *Picture, produce func() (*image.NRGBA, int, int, error)) {
	ps.slots <- struct{}{}
	img, w, h, err := produce()
	<-ps.slots
	pic.mu.Lock()
	if err != nil {
		pic.state = PictureFailed
	} else {
		pic.pending, pic.w, pic.h, pic.state = img, w, h, PictureReady
	}
	pic.mu.Unlock()
	redraw.Request()
}

func decodePicture(data []byte) (*image.NRGBA, int, int, error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, 0, 0, err
	}
	if cfg.Width*cfg.Height > pictureMaxPixels || cfg.Width == 0 || cfg.Height == 0 {
		return nil, 0, 0, image.ErrFormat
	}
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, 0, 0, err
	}
	w, h := cfg.Width, cfg.Height
	dw, dh := w, h
	if long := max(w, h); long > pictureMaxEdge {
		dw, dh = max(1, w*pictureMaxEdge/long), max(1, h*pictureMaxEdge/long)
	}
	out := image.NewNRGBA(image.Rect(0, 0, dw, dh))
	if dw == w && dh == h {
		draw.Draw(out, out.Bounds(), src, src.Bounds().Min, draw.Src)
	} else {
		xdraw.ApproxBiLinear.Scale(out, out.Bounds(), src, src.Bounds(), draw.Src, nil)
	}
	return out, w, h, nil
}

// upload makes the texture of a decoded picture; it runs on the UI thread.
func (ps *pictures) upload(pic *Picture) {
	pic.mu.Lock()
	img := pic.pending
	pic.pending = nil
	pic.mu.Unlock()
	if img == nil {
		return
	}
	raw := rl.Image{Data: unsafe.Pointer(&img.Pix[0]), Width: int32(img.Rect.Dx()), Height: int32(img.Rect.Dy()), Mipmaps: 1, Format: rl.UncompressedR8g8b8a8}
	tex := rl.LoadTextureFromImage(&raw)
	rl.SetTextureFilter(tex, rl.FilterBilinear)
	pic.mu.Lock()
	pic.tex, pic.live = tex, true
	pic.mu.Unlock()
	ps.mu.Lock()
	ps.bytes += len(img.Pix)
	ps.mu.Unlock()
	ps.evict(pic)
}

// evict lets go of the textures drawn longest ago while the pictures hold more than their budget.
func (ps *pictures) evict(keep *Picture) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	for ps.bytes > pictureBudgetBytes {
		var oldestKey picKey
		var oldest *Picture
		for key, pic := range ps.items {
			if pic == keep || !pic.live || (oldest != nil && pic.used >= oldest.used) {
				continue
			}
			oldestKey, oldest = key, pic
		}
		if oldest == nil {
			return
		}
		rl.UnloadTexture(oldest.tex)
		ps.bytes -= int(oldest.tex.Width * oldest.tex.Height * 4)
		delete(ps.items, oldestKey)
	}
}

// DrawPicture draws pic into r, covering it (cropping the overflow) when cover is set and stretching to fit otherwise.
func (p *Painter) DrawPicture(pic *Picture, r geom.Rect, radius float32, cover bool, corner color.RGBA) {
	p.drawPicture(pic, r, radius, cover, corner, rl.White)
}

// texture is the picture's texture, uploaded now if it has only just been decoded, and whether there is one yet.
func (p *Painter) texture(pic *Picture) (rl.Texture2D, bool) {
	pic.mu.Lock()
	needUpload := pic.pending != nil
	pic.mu.Unlock()
	if needUpload {
		p.b.flush()
		p.pictures.upload(pic)
	}
	pic.mu.Lock()
	tex, live := pic.tex, pic.live
	p.pictures.tick++
	pic.used = p.pictures.tick
	pic.mu.Unlock()
	if live && pic.anim != nil {
		p.animate(pic)
	}
	return tex, live
}

func (p *Painter) drawPicture(pic *Picture, r geom.Rect, radius float32, cover bool, corner, tint color.RGBA) {
	tex, live := p.texture(pic)
	if !live {
		return
	}
	src := rl.Rectangle{Width: float32(tex.Width), Height: float32(tex.Height)}
	if cover {
		want := r.W / r.H
		have := src.Width / src.Height
		if have > want {
			src.Width = src.Height * want
			src.X = (float32(tex.Width) - src.Width) / 2
		} else {
			src.Height = src.Width / want
			src.Y = (float32(tex.Height) - src.Height) / 2
		}
	}
	width, height := float32(tex.Width), float32(tex.Height)
	p.textureRect(tex.ID, p.rect(r), src.X/width, src.Y/height, (src.X+src.Width)/width, (src.Y+src.Height)/height, false, tint)
	if radius > 0 {
		p.Corners(r, radius, corner)
	}
}

// Corners paints the four corners outside a rounded rectangle, to round off what was drawn square.
func (p *Painter) Corners(r geom.Rect, radius float32, c color.RGBA) {
	p.corners(r, radius, c, 0, 4)
}

// TopCorners is Corners for the two upper corners only.
func (p *Painter) TopCorners(r geom.Rect, radius float32, c color.RGBA) {
	p.corners(r, radius, c, 0, 2)
}

func (p *Painter) corners(r geom.Rect, radius float32, c color.RGBA, from, to int) {
	type corner struct{ x, y, cx, cy, from float32 }
	all := [4]corner{
		{r.X, r.Y, r.X + radius, r.Y + radius, math.Pi},
		{r.Right(), r.Y, r.Right() - radius, r.Y + radius, 1.5 * math.Pi},
		{r.Right(), r.Bottom(), r.Right() - radius, r.Bottom() - radius, 0},
		{r.X, r.Bottom(), r.X + radius, r.Bottom() - radius, 0.5 * math.Pi},
	}
	for _, k := range all[from:to] {
		prev := [2]float32{k.cx + radius*float32(math.Cos(float64(k.from))), k.cy + radius*float32(math.Sin(float64(k.from)))}
		for i := 1; i <= cornerSteps; i++ {
			a := float64(k.from) + float64(i)*math.Pi/2/cornerSteps
			next := [2]float32{k.cx + radius*float32(math.Cos(a)), k.cy + radius*float32(math.Sin(a))}
			p.Triangle([2]float32{k.x, k.y}, prev, next, c)
			prev = next
		}
	}
}
