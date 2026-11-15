package imagecrop

import (
	"bytes"
	"errors"
	"image"
	"image/gif"
	_ "image/jpeg"
	_ "image/png"

	_ "golang.org/x/image/webp"
)

const maxPixels = 64 << 20

var ErrTooDetailed = errors.New("too detailed")

// Source is a picture picked to be cut: its pixels, and the frames when it is an animated GIF.
type Source struct {
	Image image.Image
	W, H  int
	GIF   *gif.GIF
}

// Inspect reads a picture's first frame, and every frame of a GIF that has more than one.
func Inspect(data []byte) (*Source, error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if cfg.Width == 0 || cfg.Height == 0 || cfg.Width*cfg.Height > maxPixels {
		return nil, image.ErrFormat
	}
	if len(data) > 4 && string(data[:4]) == "GIF8" {
		if g, err := gif.DecodeAll(bytes.NewReader(data)); err == nil && len(g.Image) > 1 {
			canvas := newCanvas(g)
			canvas.show(0)
			return &Source{Image: canvas.img, W: cfg.Width, H: cfg.Height, GIF: g}, nil
		}
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	return &Source{Image: img, W: cfg.Width, H: cfg.Height}, nil
}
