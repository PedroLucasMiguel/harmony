package video

import "testing"

func pixel(p *pattern, pix []byte, x, y int) (r, g, b byte) {
	i := (y*p.w + x) * 4
	return pix[i+2], pix[i+1], pix[i]
}

func TestPatternSize(t *testing.T) {
	for height, want := range map[int][2]int{720: {1280, 720}, 360: {640, 360}, 1080: {1280, 720}, 361: {640, 360}} {
		if w, h := patternSize(height); w != want[0] || h != want[1] {
			t.Errorf("%d: got %dx%d; want %dx%d", height, w, h, want[0], want[1])
		}
	}
}

func TestBarsAreTheExactColoursAndStay(t *testing.T) {
	w, h := patternSize(720)
	p := newPattern(w, h, false)
	pix := p.next()
	for i, c := range BarColours {
		r, g, b := pixel(p, pix, i*w/len(BarColours)+w/20, h/2)
		if [3]byte{r, g, b} != c {
			t.Errorf("bar %d is %v; want %v", i, [3]byte{r, g, b}, c)
		}
	}
	if &p.next()[0] != &pix[0] {
		t.Error("bars are drawn once")
	}
}

func TestTestPatternMovesAndCountsPictures(t *testing.T) {
	w, h := patternSize(360)
	p := newPattern(w, h, true)
	counter := func(pix []byte) (n int) {
		for i := 0; i < counterBits; i++ {
			if r, _, _ := pixel(p, pix, i*w/counterBits+1, h-2); r == 255 {
				n |= 1 << i
			}
		}
		return n
	}
	first := append([]byte(nil), p.next()...)
	for range 4 {
		p.next()
	}
	fifth := p.next()
	if counter(first) != 0 || counter(fifth) != 5 {
		t.Errorf("the counter reads %d and %d; want 0 and 5", counter(first), counter(fifth))
	}
	if string(first) == string(fifth) {
		t.Error("the pattern does not move")
	}
}
