package native

import (
	"bytes"
	"image"
	"image/jpeg"
	"testing"
)

func TestYUYVToNV12(t *testing.T) {
	// 4x2: Y 10 20 30 40 / 50 60 70 80; chroma pairs (U,V): (100,110) (120,130) over (140,150) (160,170)
	src := []byte{10, 100, 20, 110, 30, 120, 40, 130, 50, 140, 60, 150, 70, 160, 80, 170}
	dst := make([]byte, nv12Size(4, 2))
	newCamConverter(v4l2PixYUYV, 4, 2, 0, 4, 2).convert(dst, src)
	want := []byte{10, 20, 30, 40, 50, 60, 70, 80, 120, 130, 140, 150}
	if !bytes.Equal(dst, want) {
		t.Errorf("got %v want %v", dst, want)
	}
}

func TestNV12ScaledKeepsFlatColour(t *testing.T) {
	src := make([]byte, nv12Size(64, 48))
	for i := range 64 * 48 {
		src[i] = 90
	}
	for i := 64 * 48; i < len(src); i += 2 {
		src[i], src[i+1] = 100, 200
	}
	dst := make([]byte, nv12Size(32, 24))
	if err := newCamConverter(v4l2PixNV12, 64, 48, 0, 32, 24).convert(dst, src); err != nil {
		t.Fatal(err)
	}
	if dst[0] != 90 || dst[32*24] != 100 || dst[32*24+1] != 200 {
		t.Errorf("colour changed: %d %d %d", dst[0], dst[32*24], dst[32*24+1])
	}
}

func TestMJPEGBecomesLimitedRange(t *testing.T) {
	for _, c := range []struct {
		name         string
		y, cb, cr    uint8
		wantY, wantC byte
	}{{"white", 255, 128, 128, 235, 128}, {"black", 0, 128, 128, 16, 128}} {
		img := image.NewYCbCr(image.Rect(0, 0, 32, 32), image.YCbCrSubsampleRatio420)
		for i := range img.Y {
			img.Y[i] = c.y
		}
		for i := range img.Cb {
			img.Cb[i], img.Cr[i] = c.cb, c.cr
		}
		var b bytes.Buffer
		if err := jpeg.Encode(&b, img, &jpeg.Options{Quality: 100}); err != nil {
			t.Fatal(err)
		}
		dst := make([]byte, nv12Size(16, 16))
		if err := newCamConverter(v4l2PixMJPG, 32, 32, 0, 16, 16).convert(dst, b.Bytes()); err != nil {
			t.Fatal(err)
		}
		if d := int(dst[0]) - int(c.wantY); d < -1 || d > 1 || dst[16*16] != c.wantC {
			t.Errorf("%s: Y %d (want %d), Cb %d (want %d)", c.name, dst[0], c.wantY, dst[16*16], c.wantC)
		}
	}
}

func TestMJPEGWithoutHuffmanTables(t *testing.T) {
	img := image.NewYCbCr(image.Rect(0, 0, 32, 32), image.YCbCrSubsampleRatio422)
	var b bytes.Buffer
	if err := jpeg.Encode(&b, img, nil); err != nil {
		t.Fatal(err)
	}
	full := b.Bytes()
	at := bytes.Index(full, []byte{0xff, 0xc4})
	end := at + 2 + int(full[at+2])<<8 + int(full[at+3])
	stripped := append(append([]byte(nil), full[:at]...), full[end:]...)
	if _, err := jpeg.Decode(bytes.NewReader(stripped)); err == nil {
		t.Fatal("the standard library decoded a frame without tables: the test proves nothing")
	}
	dst := make([]byte, nv12Size(16, 16))
	if err := newCamConverter(v4l2PixMJPG, 32, 32, 0, 16, 16).convert(dst, stripped); err != nil {
		t.Fatal(err)
	}
}
