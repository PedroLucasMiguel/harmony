// Telling a camera that opens black from a dark room: a few rows of a small picture decoded from what is being sent.
package video

import (
	"sync"
	"sync/atomic"

	"harmony/v2/internal/video/native"
)

const (
	// A dark room has noise in it, a camera that is not working does not: black is a mean at or under 3 (of 255) with no bright pixel.
	blackMean = 3
	blackPeak = 24
	blackRows = 6
	probeW    = 64
	probeH    = 36
)

// IsBlack is whether a w by h RGBA picture is black, judged on a few rows spread over it.
func IsBlack(rgba []byte, w, h int) bool {
	if w <= 0 || h <= 0 || len(rgba) < w*h*4 {
		return true
	}
	sum, peak, n := 0, 0, 0
	for i := 0; i < blackRows; i++ {
		row := rgba[((2*i+1)*h/(2*blackRows))*w*4:][:w*4]
		for x := 0; x < len(row); x += 4 {
			luma := (54*int(row[x]) + 183*int(row[x+1]) + 19*int(row[x+2])) >> 8
			sum += luma
			peak = max(peak, luma)
			n++
		}
	}
	return sum <= blackMean*n && peak <= blackPeak
}

// BlackProbe decodes the access units of a stream at a tiny size and says whether what comes out is black. It costs a
// small decoder for as long as it is fed.
type BlackProbe struct {
	// RequestKeyFrame is asked for when the decoder cannot start before one.
	RequestKeyFrame func()

	mu       sync.Mutex
	dec      native.Decoder
	srcW     int
	srcH     int
	closed   bool
	pictures atomic.Int32
	lit      atomic.Int32
}

// Feed takes one access unit; it never blocks for long and is safe to call from the stream's own goroutine.
func (p *BlackProbe) Feed(au []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return
	}
	if pic := ParsePicture(au); pic.W > 0 && (p.dec == nil || pic.W != p.srcW || pic.H != p.srcH) {
		if p.dec != nil {
			p.dec.Close()
			p.dec = nil
		}
		p.srcW, p.srcH = pic.W, pic.H
		dec, err := native.NewDecoder(native.DecodeParams{Width: probeW, Height: probeH, Matrix: pic.Matrix, Full: pic.Full}, p.picture)
		if err != nil {
			p.closed = true
			return
		}
		p.dec = dec
	}
	if p.dec != nil && p.dec.Write(au) && p.RequestKeyFrame != nil {
		p.RequestKeyFrame()
	}
}

func (p *BlackProbe) picture(rgba []byte, w, h int) {
	p.pictures.Add(1)
	if !IsBlack(rgba, w, h) {
		p.lit.Add(1)
	}
}

// Verdict is whether pictures came out and none of them had anything in it. With no picture yet, or a decoder that
// could not start, it says false: nothing is known, so nothing is blamed on the camera.
func (p *BlackProbe) Verdict() (black bool) { return p.pictures.Load() > 0 && p.lit.Load() == 0 }

// Lit is whether a picture with something in it has come out.
func (p *BlackProbe) Lit() bool { return p.lit.Load() > 0 }

func (p *BlackProbe) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	if p.dec != nil {
		p.dec.Close()
		p.dec = nil
	}
}
