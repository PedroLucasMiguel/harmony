package widget

import (
	"unsafe"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/raw"
)

// Pictures is a source of decoded video pictures; video.Frame is one.
type Pictures interface {
	View(have uint64, fn func(pix []byte, w, h int)) uint64
}

// GPUPictures is a source that can keep its pictures in graphics memory: Texture is the latest one as a texture of the
// window's graphics context, ok false when the source has them in system memory (View); FreeTexture gives the texture back.
type GPUPictures interface {
	Texture(have uint64) (id uint32, w, h int, version uint64, ok bool)
	FreeTexture()
}

// Surface is the texture a stream's pictures are shown through. It is made on the first picture, uploaded to only when
// the picture has a new version, and given back with Close. A source that keeps its pictures in graphics memory gives the
// texture itself, which the Surface only points at.
type Surface struct {
	tex     rl.Texture2D
	live    bool
	version uint64
	gpu     GPUPictures
	// uploader is s.upload, made once so that asking for a picture allocates nothing.
	uploader func(pix []byte, w, h int)
}

// Update uploads the latest picture of src if it is newer than the one on the texture, and reports whether there is a
// picture to draw.
func (s *Surface) Update(src Pictures) bool {
	if g, ok := src.(GPUPictures); ok {
		if id, w, h, version, ok := g.Texture(s.version); ok {
			if s.gpu == nil {
				s.Close()
			}
			s.gpu = g
			s.tex = rl.Texture2D{ID: id, Width: int32(w), Height: int32(h), Mipmaps: 1, Format: rl.UncompressedR8g8b8a8}
			s.live, s.version = true, version
			return true
		}
		if s.gpu != nil {
			// the source went back to system memory: its pictures are drawn from a texture of this surface from now on
			s.gpu, s.live, s.version = nil, false, 0
		}
	}
	if s.uploader == nil {
		s.uploader = s.upload
	}
	s.version = src.View(s.version, s.uploader)
	return s.live
}

func (s *Surface) upload(pix []byte, w, h int) {
	if !s.live || int(s.tex.Width) != w || int(s.tex.Height) != h {
		s.Close()
		img := rl.Image{Data: unsafe.Pointer(&pix[0]), Width: int32(w), Height: int32(h), Mipmaps: 1, Format: rl.UncompressedR8g8b8a8}
		s.tex, s.live = rl.LoadTextureFromImage(&img), true
		rl.SetTextureFilter(s.tex, rl.FilterBilinear)
		return
	}
	raw.UpdateTexture(s.tex, pix)
}

// Size is the picture's size in pixels, 0, 0 before the first.
func (s *Surface) Size() (w, h int) {
	if !s.live {
		return 0, 0
	}
	return int(s.tex.Width), int(s.tex.Height)
}

func (s *Surface) Close() {
	if !s.live {
		return
	}
	if s.gpu != nil {
		s.gpu.FreeTexture()
		s.gpu = nil
	} else {
		rl.UnloadTexture(s.tex)
	}
	s.live, s.version = false, 0
}
