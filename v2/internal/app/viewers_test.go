package app

import "testing"

func TestFitKeepsShapeNeverGrowsAndStaysEven(t *testing.T) {
	for _, c := range []struct{ sw, sh, bw, bh, w, h int }{
		{1280, 720, 320, 180, 320, 180},
		{1280, 720, 400, 400, 400, 224},
		{720, 1280, 400, 400, 224, 400},
		{640, 360, 1280, 720, 640, 360},
		{1920, 1080, 1280, 720, 1280, 720},
		{1281, 721, 5000, 5000, 1280, 720},
	} {
		if w, h := fit(c.sw, c.sh, c.bw, c.bh); w != c.w || h != c.h {
			t.Errorf("fit(%dx%d in %dx%d) = %dx%d, want %dx%d", c.sw, c.sh, c.bw, c.bh, w, h, c.w, c.h)
		}
	}
}

func TestResizeNeedsARealChange(t *testing.T) {
	for _, c := range []struct {
		have, want int
		restart    bool
	}{{320, 320, false}, {320, 330, false}, {320, 640, true}, {640, 400, false}, {640, 300, true}} {
		if worthRestarting(c.have, c.want) != c.restart {
			t.Errorf("%d -> %d: want restart=%v", c.have, c.want, c.restart)
		}
	}
}
