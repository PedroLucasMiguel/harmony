package paint

import (
	"bytes"
	"image"
	"image/color"
	"image/gif"
	"testing"
	"time"
)

func frame(r image.Rectangle, index uint8, pal color.Palette) *image.Paletted {
	f := image.NewPaletted(r, pal)
	for i := range f.Pix {
		f.Pix[i] = index
	}
	return f
}

func TestAnimationCompositesDisposesAndHoldsTheLastFrame(t *testing.T) {
	red, green := color.RGBA{255, 0, 0, 255}, color.RGBA{0, 255, 0, 255}
	pal := color.Palette{color.RGBA{}, red, green}
	g := &gif.GIF{
		Image:     []*image.Paletted{frame(image.Rect(0, 0, 4, 4), 1, pal), frame(image.Rect(1, 2, 3, 3), 2, pal), frame(image.Rect(0, 0, 4, 4), 0, pal)},
		Delay:     []int{5, 5, 5},
		Disposal:  []byte{gif.DisposalNone, gif.DisposalBackground, gif.DisposalNone},
		LoopCount: -1,
		Config:    image.Config{ColorModel: pal, Width: 4, Height: 4},
	}
	var data bytes.Buffer
	if err := gif.EncodeAll(&data, g); err != nil {
		t.Fatal(err)
	}
	a, first, w, h := decodeAnimation(data.Bytes())
	if a == nil || w != 4 || h != 4 || first.NRGBAAt(0, 0) != (color.NRGBA{255, 0, 0, 255}) {
		t.Fatalf("first frame not red: %v %d %d", a, w, h)
	}
	if a.dirtyTop < a.dirtyBottom {
		t.Fatal("the first picture is not a change to upload")
	}

	a.advance()
	if a.canvas[2*4+1] != green || a.canvas[0] != red || a.dirtyTop != 2 || a.dirtyBottom != 3 {
		t.Fatalf("second frame should be one green patch in the rows 2..3 over red: %v dirty %d..%d", a.canvas, a.dirtyTop, a.dirtyBottom)
	}
	a.advance()
	if a.canvas[2*4+1] != (color.RGBA{}) || a.canvas[0] != red {
		t.Fatalf("disposing the patch to the background should leave a transparent hole, left %v", a.canvas[2*4+1])
	}
	if a.advance() || !a.finished() || a.canvas[0] != red || a.cur != 2 {
		t.Fatal("a GIF without a loop count plays once and keeps its last frame")
	}
}

func TestSweepDropsOnlySizesNobodyAsksForAndKeepsTheSharedAnimation(t *testing.T) {
	ps := newPictures()
	now := time.Now().UnixNano()
	idle := &Picture{seen: now - int64(2*sizedIdle)}
	asked := &Picture{seen: now}
	shared := &Picture{}
	still := &Picture{}
	ps.items[picKey{key: "a", px: 40<<16 | 40}] = idle
	ps.items[picKey{key: "a", px: 41<<16 | 41}] = asked
	ps.items[picKey{key: "a", px: -1}] = shared
	ps.items[picKey{key: "b"}] = still

	ps.sweep(now)

	if len(ps.items) != 3 || ps.items[picKey{key: "a", px: 40<<16 | 40}] != nil || !idle.isDead() || asked.isDead() {
		t.Fatalf("only the size that was not asked for goes: %d entries left", len(ps.items))
	}
}
