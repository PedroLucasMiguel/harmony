package imagecrop

import (
	"bytes"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
)

// Result is a cut picture as the file to upload.
type Result struct {
	Data        []byte
	ContentType string
}

var jpegQualities = [...]int{90, 80, 65, 50, 35}

// Encode cuts what is under the mask and writes it as a file that fits what the server takes: a GIF that moves if the source
// does, else a JPEG tried at lower quality until it fits, or a PNG first where the kind keeps one. ErrTooDetailed when nothing fits.
func Encode(src *Source, p Placement, m Mask, k Kind) (Result, error) {
	if src.GIF != nil && k.Gif.W > 0 {
		return encodeGIF(src, p, m, k.Gif)
	}
	return encodeStill(src.Image, p, m, k.Still)
}

func encodeStill(img image.Image, p Placement, m Mask, o Output) (Result, error) {
	out := image.NewNRGBA(image.Rect(0, 0, o.W, o.H))
	if o.PNG {
		Render(out, img, p, m, true)
		var b bytes.Buffer
		enc := png.Encoder{CompressionLevel: png.BestCompression}
		if enc.Encode(&b, out) == nil && b.Len() <= o.MaxBytes {
			return Result{b.Bytes(), "image/png"}, nil
		}
	}
	Render(out, img, p, m, false)
	for _, q := range jpegQualities {
		var b bytes.Buffer
		if jpeg.Encode(&b, out, &jpeg.Options{Quality: q}) == nil && b.Len() <= o.MaxBytes {
			return Result{b.Bytes(), "image/jpeg"}, nil
		}
	}
	return Result{}, ErrTooDetailed
}

const maxFrames = 120

// plan is a way to write a GIF, from the best to the barest: the size it is drawn at, the colours it keeps, and how many frames are dropped.
type plan struct {
	size   float64
	colors int
	skip   int
}

func encodeGIF(src *Source, p Placement, m Mask, o Output) (Result, error) {
	base := (len(src.GIF.Image) + maxFrames - 1) / maxFrames
	for _, pl := range []plan{{1, 256, base}, {1, 128, base}, {0.75, 128, base}, {0.75, 64, base * 2}, {0.5, 64, base * 2}, {0.5, 32, base * 3}} {
		data := writeGIF(src.GIF, p, m, int(float64(o.W)*pl.size), int(float64(o.H)*pl.size), pl)
		if len(data) <= o.MaxBytes {
			return Result{data, "image/gif"}, nil
		}
	}
	return Result{}, ErrTooDetailed
}

type cutFrame struct {
	pix   *image.NRGBA
	delay int
}

func writeGIF(g *gif.GIF, p Placement, m Mask, w, h int, pl plan) []byte {
	var frames []cutFrame
	canvas := newCanvas(g)
	for i := range g.Image {
		canvas.show(i)
		delay := g.Delay[i]
		if delay <= 1 {
			delay = 10
		}
		if i%pl.skip == 0 {
			pix := image.NewNRGBA(image.Rect(0, 0, w, h))
			Render(pix, canvas.img, p, m, false)
			frames = append(frames, cutFrame{pix, delay})
		} else {
			frames[len(frames)-1].delay += delay
		}
	}
	palette := quantize(frames, pl.colors)
	lut := newLookup(palette)
	out := &gif.GIF{Config: image.Config{ColorModel: palette, Width: w, Height: h}}
	for _, f := range frames {
		img := image.NewPaletted(f.pix.Rect, palette)
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				i := f.pix.PixOffset(x, y)
				img.Pix[y*img.Stride+x] = lut.index(f.pix.Pix[i], f.pix.Pix[i+1], f.pix.Pix[i+2])
			}
		}
		out.Image = append(out.Image, img)
		out.Delay = append(out.Delay, f.delay)
		out.Disposal = append(out.Disposal, gif.DisposalNone)
	}
	var b bytes.Buffer
	if gif.EncodeAll(&b, out) != nil {
		return nil
	}
	return b.Bytes()
}
