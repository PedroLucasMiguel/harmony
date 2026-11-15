package native

import (
	"math"
	"testing"
)

func TestAxisWeightsAddUp(t *testing.T) {
	for _, c := range [][2]int{{1920, 1280}, {3840, 1280}, {1280, 1920}, {640, 640}, {7, 3}, {3, 7}, {1081, 720}} {
		a := newAxisWeights(c[0], c[1])
		for i := range c[1] {
			var sum int32
			for t := range int(a.count[i]) {
				sum += a.w[int(a.off[i])+t]
			}
			if sum != 65536 {
				t.Fatalf("%v: weights of %d add up to %d", c, i, sum)
			}
			if int(a.first[i])+int(a.count[i]) > c[0] {
				t.Fatalf("%v: taps of %d run past the source", c, i)
			}
		}
	}
}

func TestScalerFlatPictureStaysFlat(t *testing.T) {
	for _, c := range [][4]int{{64, 48, 32, 24}, {50, 30, 33, 17}, {16, 16, 40, 24}} {
		for _, ch := range []int{1, 2, 4} {
			src := make([]byte, c[0]*c[1]*ch)
			for i := range src {
				src[i] = byte(100 + i%ch*30)
			}
			dst := make([]byte, c[2]*c[3]*ch)
			newCapScaler(c[0], c[1], c[2], c[3], ch).scale(dst, c[2]*ch, src, c[0]*ch)
			for i, v := range dst {
				if v != byte(100+i%ch*30) {
					t.Fatalf("%v ch %d: byte %d is %d", c, ch, i, v)
				}
			}
		}
	}
}

func TestScalerHalvesByAveraging(t *testing.T) {
	src := make([]byte, 4*4)
	for i := range src {
		src[i] = byte(i * 10)
	}
	dst := make([]byte, 4)
	newCapScaler(4, 4, 2, 2, 1).scale(dst, 2, src, 4)
	want := []byte{25, 45, 105, 125}
	for i := range want {
		if dst[i] != want[i] {
			t.Fatalf("got %v want %v", dst, want)
		}
	}
}

func TestScalerBilinearGradient(t *testing.T) {
	src := []byte{0, 100, 200, 0, 100, 200}
	dst := make([]byte, 6*2)
	newCapScaler(3, 2, 6, 2, 1).scale(dst, 6, src, 3)
	var prev byte
	for x := range 6 {
		if dst[x] < prev {
			t.Fatalf("not monotone: %v", dst[:6])
		}
		prev = dst[x]
	}
	if math.Abs(float64(dst[1])-25) > 1 || math.Abs(float64(dst[2])-75) > 1 {
		t.Errorf("pixels 1 and 2 are %d and %d, want 25 and 75", dst[1], dst[2])
	}
}

func BenchmarkScaler1080To720BGRA(b *testing.B) {
	src := make([]byte, 1920*1080*4)
	dst := make([]byte, 1280*720*4)
	s := newCapScaler(1920, 1080, 1280, 720, 4)
	b.ReportAllocs()
	for range b.N {
		s.scale(dst, 1280*4, src, 1920*4)
	}
}
