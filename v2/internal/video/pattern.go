// The synthetic sources "bars", "test" and "black": pictures drawn in Go at the asked rate and fed to the system's encoder,
// so a call can be tried without a screen or camera.
package video

import (
	"sync"
	"time"

	"harmony/v2/internal/video/native"
)

const (
	patternMaxHeight = 720
	counterBits      = 32
	boxSpeed         = 8
)

// patternSize is the size of the picture of a synthetic source asked for at this height: 16:9, even sides, at most 720 high.
func patternSize(height int) (w, h int) {
	h = max(min(height, patternMaxHeight)&^1, 2)
	return max(h*16/9&^1, 2), h
}

// pattern draws one picture at a time into pix, BGRA.
type pattern struct {
	w, h   int
	moving bool
	base   []byte
	pix    []byte
	n      int
}

func newPattern(w, h int, moving bool) *pattern {
	p := &pattern{w: w, h: h, moving: moving, base: make([]byte, w*h*4), pix: make([]byte, w*h*4)}
	if moving {
		p.paintGradient()
	} else {
		p.paintBars()
	}
	copy(p.pix, p.base)
	return p
}

func (p *pattern) fill(x0, y0, x1, y1 int, b, g, r byte, dst []byte) {
	for y := y0; y < y1; y++ {
		row := dst[(y*p.w+x0)*4 : (y*p.w+x1)*4]
		for i := 0; i < len(row); i += 4 {
			row[i], row[i+1], row[i+2], row[i+3] = b, g, r, 255
		}
	}
}

// paintBars draws BarColours as equal columns, the last one taking what is left over.
func (p *pattern) paintBars() {
	for i, c := range BarColours {
		x1 := (i + 1) * p.w / len(BarColours)
		p.fill(i*p.w/len(BarColours), 0, x1, p.h, c[2], c[1], c[0], p.base)
	}
}

// paintGradient draws a diagonal ramp, so the encoder has something to code besides flat colour.
func (p *pattern) paintGradient() {
	for y := 0; y < p.h; y++ {
		row := p.base[y*p.w*4 : (y+1)*p.w*4]
		for x := 0; x < p.w; x++ {
			v := byte((x*255/p.w + y*255/p.h) / 2)
			row[x*4], row[x*4+1], row[x*4+2], row[x*4+3] = 255-v, v, byte(x*255/p.w), 255
		}
	}
}

// next draws the following picture and returns it. The moving pattern is a square that crosses the picture and a bar
// along the bottom that shows the picture's number in binary, the lowest bit on the left, white for one, so motion and
// order can be seen and checked.
func (p *pattern) next() []byte {
	if !p.moving {
		return p.pix
	}
	copy(p.pix, p.base)
	side := p.h / 5
	x := p.n * boxSpeed % (p.w - side)
	y := p.h/5 + (p.h/2-side)*(p.n*boxSpeed/(p.w-side)%2)
	p.fill(x, y, x+side, y+side, 255, 255, 255, p.pix)
	barY := p.h - p.h/12
	for i := 0; i < counterBits; i++ {
		v := byte(0)
		if p.n>>i&1 == 1 {
			v = 255
		}
		p.fill(i*p.w/counterBits, barY, (i+1)*p.w/counterBits, p.h, v, v, v, p.pix)
	}
	p.n++
	return p.pix
}

// patternSource feeds a pattern to an encoder at a steady rate.
type patternSource struct {
	enc  native.Encoder
	stop chan struct{}
	done chan struct{}
	once sync.Once
}

func startPattern(opts CaptureOptions, onAU func([]byte)) (*patternSource, error) {
	w, h := patternSize(opts.Height)
	enc, err := native.NewEncoder(native.EncodeParams{
		Width: w, Height: h, FPS: opts.FPS, BitrateKbps: opts.BitrateKbps, Matrix: opts.colour().Matrix, Backend: opts.Encoder,
	}, onAU)
	if err != nil {
		return nil, err
	}
	s := &patternSource{enc: enc, stop: make(chan struct{}), done: make(chan struct{})}
	pat := newPattern(w, h, opts.Source == "test")
	if opts.Source == "black" {
		pat.fill(0, 0, w, h, 0, 0, 0, pat.pix)
	}
	go s.run(pat, opts.FPS)
	return s, nil
}

func (s *patternSource) run(p *pattern, fps int) {
	defer close(s.done)
	tick := time.NewTicker(time.Second / time.Duration(fps))
	defer tick.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-tick.C:
			if s.enc.EncodeBGRA(p.next(), p.w*4) != nil {
				return
			}
		}
	}
}

func (s *patternSource) mode() string { return s.enc.Mode() }

func (s *patternSource) close() {
	s.once.Do(func() {
		close(s.stop)
		<-s.done
		s.enc.Close()
	})
}
