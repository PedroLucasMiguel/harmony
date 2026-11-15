package imagecrop

import (
	"bytes"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"testing"
)

func solid(w, h int, c color.Color) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(img.Pix); i += 4 {
		r, g, b, a := c.RGBA()
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = uint8(r>>8), uint8(g>>8), uint8(b>>8), uint8(a>>8)
	}
	return img
}

func TestAvatarIsAJPEGOfTheKeptSize(t *testing.T) {
	src := &Source{Image: solid(900, 600, color.RGBA{200, 30, 30, 255}), W: 900, H: 600}
	m := Mask{X: 10, Y: 10, W: 200, H: 200, Circle: true}
	res, err := Encode(src, Start(900, 600, m), m, Avatar)
	if err != nil || res.ContentType != "image/jpeg" || len(res.Data) > Avatar.Still.MaxBytes {
		t.Fatalf("%v %s %d", err, res.ContentType, len(res.Data))
	}
	if img, err := jpeg.Decode(bytes.NewReader(res.Data)); err != nil || img.Bounds().Dx() != 256 {
		t.Fatalf("%v %v", err, img.Bounds())
	}
}

func TestLogoKeepsTransparencyAsPNG(t *testing.T) {
	clear := image.NewNRGBA(image.Rect(0, 0, 300, 300))
	m := Mask{W: 100, H: 100}
	res, err := Encode(&Source{Image: clear, W: 300, H: 300}, Start(300, 300, m), m, Logo)
	if err != nil || res.ContentType != "image/png" {
		t.Fatalf("%v %s", err, res.ContentType)
	}
	img, _ := png.Decode(bytes.NewReader(res.Data))
	if _, _, _, a := img.At(10, 10).RGBA(); a != 0 {
		t.Fatal("what was see-through was filled")
	}
}

func TestAnimatedGIFStaysAnimated(t *testing.T) {
	pal := color.Palette{color.Black, color.White}
	g := &gif.GIF{Config: image.Config{Width: 120, Height: 120}}
	for i := 0; i < 6; i++ {
		f := image.NewPaletted(image.Rect(0, 0, 120, 120), pal)
		for x := 0; x < 20; x++ {
			f.SetColorIndex(x+i*15, 60, 1)
		}
		g.Image, g.Delay = append(g.Image, f), append(g.Delay, 8)
	}
	var b bytes.Buffer
	gif.EncodeAll(&b, g)
	src, err := Inspect(b.Bytes())
	if err != nil || src.GIF == nil {
		t.Fatal(err)
	}
	m := Mask{W: 100, H: 100, Circle: true}
	res, err := Encode(src, Start(120, 120, m), m, Avatar)
	if err != nil || res.ContentType != "image/gif" {
		t.Fatalf("%v %s", err, res.ContentType)
	}
	out, err := gif.DecodeAll(bytes.NewReader(res.Data))
	if err != nil || len(out.Image) != 6 || out.Image[0].Bounds().Dx() != Avatar.Gif.W {
		t.Fatalf("%v frames=%d", err, len(out.Image))
	}
}
