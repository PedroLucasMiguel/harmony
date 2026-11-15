package native

import (
	"encoding/hex"
	"testing"
)

func TestWinSPSReadsSizeAndColour(t *testing.T) {
	for name, c := range map[string]struct {
		au      string
		w, h    int
		matrix  int
		tagged  bool
		full    bool
		missing bool
	}{
		"1080p cropped":      {au: "000000010910000000016742c028d900780227e5c044000003000400000300283c60c920", w: 1920, h: 1080, matrix: 2},
		"high profile 360p":  {au: "0000000109100000000167640016acd940a02ff970110000030001000003000a0f162d96", w: 640, h: 360, matrix: 2},
		"tagged BT.709":      {au: "000000010910000000016742c01fd9005005bb016a04040280000003008000001e078c19240000000168cb83", w: 1280, h: 720, matrix: 1, tagged: true},
		"tagged BT.601 full": {au: "000000010910000000016742c01ed900a02ff97016e04040c8000003000800000301e078b172400000000168", w: 640, h: 360, matrix: 6, tagged: true, full: true},
		"no parameter set":   {au: "00000001091000000001419a", missing: true},
	} {
		au, _ := hex.DecodeString(c.au)
		sps, ok := winFindSPS(au)
		if ok == c.missing || (ok && (sps.w != c.w || sps.h != c.h || sps.matrix != c.matrix || sps.fullTagged != c.tagged || sps.full != c.full)) {
			t.Errorf("%s: got %+v, ok %v", name, sps, ok)
		}
	}
}

func TestWinIsIDR(t *testing.T) {
	if !winIsIDR([]byte{0, 0, 0, 1, 0x67, 1, 0, 0, 1, 0x65, 2}) || winIsIDR([]byte{0, 0, 0, 1, 0x41, 1, 2}) || winIsIDR(nil) {
		t.Fatal("IDR and non-IDR access units are told apart wrongly")
	}
}

func TestWinColourPrefersTheStream(t *testing.T) {
	p := DecodeParams{Matrix: BT601, Full: true}
	if m, f := winColour(winSPS{matrix: 1, fullTagged: true}, true, p, 320); m != BT709 || f {
		t.Fatalf("tagged stream: %d %v", m, f)
	}
	if m, f := winColour(winSPS{matrix: 2}, true, p, 1920); m != BT601 || !f {
		t.Fatalf("silent stream takes the caller's: %d %v", m, f)
	}
	if m, _ := winColour(winSPS{matrix: 2}, true, DecodeParams{}, 1920); m != BT709 {
		t.Fatalf("silent HD stream is BT.709, got %d", m)
	}
	if m, _ := winColour(winSPS{matrix: 2}, true, DecodeParams{}, 640); m != BT601 {
		t.Fatalf("silent SD stream is BT.601, got %d", m)
	}
}

func TestWinFitShrinksNeverEnlarges(t *testing.T) {
	for _, c := range []struct{ w, h, bw, bh, ow, oh int }{
		{1920, 1080, 1280, 720, 1280, 720},
		{1920, 1080, 640, 640, 640, 360},
		{1080, 1920, 640, 640, 360, 640},
		{640, 360, 1920, 1080, 640, 360},
		{1280, 720, 0, 0, 1280, 720},
	} {
		if ow, oh := winFit(c.w, c.h, c.bw, c.bh); ow != c.ow || oh != c.oh {
			t.Errorf("%dx%d in %dx%d: got %dx%d, want %dx%d", c.w, c.h, c.bw, c.bh, ow, oh, c.ow, c.oh)
		}
	}
}

func TestWinScalerKeepsFlatColourAndAverages(t *testing.T) {
	const sw, sh, dw, dh = 64, 36, 32, 18
	src := make([]byte, sw*sh)
	for i := range src {
		src[i] = 100
	}
	dst := make([]byte, dw*dh)
	s := newWinScaler()
	s.plane(dst, dw, dh, src, sw, sw, sh, 1)
	for i, v := range dst {
		if v != 100 {
			t.Fatalf("luma %d is %d", i, v)
		}
	}
	for y := 0; y < sh; y++ {
		for x := 0; x < sw; x++ {
			src[y*sw+x] = byte(x % 2 * 200)
		}
	}
	s.plane(dst, dw, dh, src, sw, sw, sh, 1)
	if dst[0] != 100 {
		t.Fatalf("a stripe pattern averages to 100, got %d", dst[0])
	}
	uv := make([]byte, sw*sh/2)
	for i := 0; i < len(uv); i += 2 {
		uv[i], uv[i+1] = 90, 160
	}
	out := make([]byte, dw*dh/2)
	s.plane(out, dw/2, dh/2, uv, sw, sw/2, sh/2, 2)
	if out[0] != 90 || out[1] != 160 || out[len(out)-2] != 90 || out[len(out)-1] != 160 {
		t.Fatalf("chroma pairs stay apart: %v", out[:4])
	}
}
