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

// Surface is the texture a stream's pictures are shown through. It is made on the first picture, uploaded to only when
// the picture has a new version, and given back with Close.
type Surface struct {
	tex     rl.Texture2D
	live    bool
	version uint64
	// uploader is s.upload, made once so that asking for a picture allocates nothing.
	uploader func(pix []byte, w, h int)
}

// Update uploads the latest picture of src if it is newer than the one on the texture, and reports whether there is a
// picture to draw.
func (s *Surface) Update(src Pictures) bool {
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
	if s.live {
		rl.UnloadTexture(s.tex)
		s.live, s.version = false, 0
	}
}
