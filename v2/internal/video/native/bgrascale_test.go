package native

import "testing"

func TestScaledSize(t *testing.T) {
	for _, c := range []struct{ sw, sh, want, w, h int }{
		{3840, 2160, 1080, 1920, 1080},
		{1920, 1080, 720, 1280, 720},
		{1366, 768, 720, 1280, 720},
		{1280, 720, 1080, 1280, 720},
		{1440, 900, 0, 1440, 900},
		{1920, 1080, 481, 852, 480},
	} {
		if w, h := scaledSize(c.sw, c.sh, c.want); w != c.w || h != c.h {
			t.Errorf("%dx%d to %d: got %dx%d want %dx%d", c.sw, c.sh, c.want, w, h, c.w, c.h)
		}
	}
}

func TestScalerAveragesAndFlips(t *testing.T) {
	src := make([]byte, 4*4*4)
	for y := 0; y < 4; y++ {
		for x := 0; x < 4; x++ {
			v := byte(0)
			if (x/2+y/2)%2 == 1 {
				v = 200
			}
			copy(src[(y*4+x)*4:], []byte{v, v, v, 255})
		}
	}
	dst := make([]byte, 2*2*4)
	newBGRAScaler(4, 4, 2, 2).scale(dst, src, 16)
	if dst[0] != 0 || dst[4] != 200 || dst[8] != 200 || dst[12] != 0 || dst[3] != 255 {
		t.Fatalf("blocks: %v", dst)
	}
	mixed := make([]byte, 2*2*4)
	newBGRAScaler(4, 4, 1, 1).scale(mixed[:4], src, 16)
	if mixed[0] != 100 {
		t.Fatalf("mean: %d", mixed[0])
	}
	flipped := make([]byte, len(src))
	for y := 0; y < 4; y++ {
		copy(flipped[(3-y)*16:], src[y*16:(y+1)*16])
	}
	again := make([]byte, 2*2*4)
	newBGRAScaler(4, 4, 2, 2).scale(again, flipped, -16)
	for i := range dst {
		if dst[i] != again[i] {
			t.Fatalf("bottom-up differs at %d", i)
		}
	}
}
