package native

import "testing"

func solid(w, h int, b, g, r byte) []byte {
	px := make([]byte, w*h*4)
	for i := 0; i < len(px); i += 4 {
		px[i], px[i+1], px[i+2], px[i+3] = b, g, r, 255
	}
	return px
}

func TestBGRAToNV12KnownValues(t *testing.T) {
	cases := []struct {
		name      string
		matrix    int
		b, g, r   byte
		y, cb, cr int
	}{
		{"black", BT709, 0, 0, 0, 16, 128, 128},
		{"white", BT709, 255, 255, 255, 235, 128, 128},
		{"red709", BT709, 0, 0, 255, 63, 102, 240},
		{"red601", BT601, 0, 0, 255, 82, 90, 240},
		{"blue709", BT709, 255, 0, 0, 32, 240, 118},
	}
	for _, c := range cases {
		dst := make([]byte, nv12Size(4, 4))
		bgraToNV12(dst, solid(4, 4, c.b, c.g, c.r), 4, 4, 16, c.matrix)
		for _, p := range []struct {
			got  byte
			want int
		}{{dst[0], c.y}, {dst[16], c.cb}, {dst[17], c.cr}} {
			if d := int(p.got) - p.want; d < -1 || d > 1 {
				t.Errorf("%s: got %d want %d", c.name, p.got, p.want)
			}
		}
	}
}

func TestBottomUpStride(t *testing.T) {
	top := solid(4, 2, 0, 0, 0)
	bottom := solid(4, 2, 255, 255, 255)
	flipped := append(append([]byte(nil), bottom...), top...)
	up, down := make([]byte, nv12Size(4, 4)), make([]byte, nv12Size(4, 4))
	bgraToNV12(up, append(append([]byte(nil), top...), bottom...), 4, 4, 16, BT709)
	bgraToNV12(down, flipped, 4, 4, -16, BT709)
	for i := range up {
		if up[i] != down[i] {
			t.Fatalf("byte %d: %d != %d", i, up[i], down[i])
		}
	}
}

func TestRoundTrip(t *testing.T) {
	for _, m := range []int{BT709, BT601} {
		src := solid(8, 8, 40, 120, 200)
		nv := make([]byte, nv12Size(8, 8))
		bgraToNV12(nv, src, 8, 8, 32, m)
		rgba := make([]byte, 8*8*4)
		nv12ToRGBA(rgba, nv[:64], 8, nv[64:], 8, 8, 8, m, false)
		for i, want := range []int{200, 120, 40, 255} {
			if d := int(rgba[i]) - want; d < -2 || d > 2 {
				t.Errorf("matrix %d channel %d: got %d want %d", m, i, rgba[i], want)
			}
		}
	}
}

func TestFullRangeNV12(t *testing.T) {
	y, uv := []byte{0, 255, 0, 255}, []byte{128, 128}
	out := make([]byte, 16)
	nv12ToRGBA(out, y, 2, uv, 2, 2, 2, BT601, true)
	if out[0] != 0 || out[4] != 255 {
		t.Fatalf("full range: %v", out)
	}
}

func BenchmarkBGRAToNV12_1080p(b *testing.B) {
	src, dst := solid(1920, 1080, 10, 100, 200), make([]byte, nv12Size(1920, 1080))
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		bgraToNV12(dst, src, 1920, 1080, 1920*4, BT709)
	}
}
