//go:build windows

// Window capture: the window draws itself into a bitmap with PrintWindow, which works whatever is over it, the pointer is
// blended in and the picture goes to the same encoder the screen uses. When the window changes size the capture and the
// encoder are made again for the new size; when it is closed the capture ends and says so.
package native

import (
	"errors"
	"fmt"
	"time"
)

const maxNativeLines = 2160

var errWindowGone = errors.New("the window was closed")

// windowShare is one run of the capture, for one size of the window.
type windowShare struct {
	c        *winCapture
	p        CaptureParams
	hwnd     uintptr
	rect     winRect
	surface  *gdiSurface
	enc      *mftEncoder
	scaler   *bgraScaler
	scaled   []byte
	w, h     int
	pointer  pointer
	lastGood bool
}

func (s *windowShare) release() {
	if s.enc != nil {
		s.c.enc.Store(nil)
		s.enc.Close()
	}
	if s.surface != nil {
		s.surface.close()
	}
}

func (s *windowShare) build() error {
	var ok bool
	if s.rect, ok = windowRect(s.hwnd); !ok || sys(procIsWindow, s.hwnd) == 0 {
		return errWindowGone
	}
	var err error
	if s.surface, err = newGDISurface(s.rect.w(), s.rect.h()); err != nil {
		return err
	}
	want := s.p.Height
	if s.p.Native {
		want = min(s.rect.h(), maxNativeLines)
	}
	s.w, s.h = scaledSize(s.rect.w(), s.rect.h(), want)
	if s.w != s.rect.w() || s.h != s.rect.h() {
		s.scaler, s.scaled = newBGRAScaler(s.rect.w(), s.rect.h(), s.w, s.h), make([]byte, s.w*s.h*4)
	}
	s.enc, err = newMFTEncoder(EncodeParams{Width: s.w, Height: s.h, FPS: s.p.FPS, BitrateKbps: s.p.BitrateKbps,
		Matrix: s.p.Matrix, Backend: s.p.Backend}, s.c.deliver, nil)
	if err == nil {
		s.c.enc.Store(s.enc)
	}
	return err
}

// grab has the window draw itself and sends the picture, with the pointer if it is over the window. It says whether the window
// kept its size; a window that was made smaller or larger needs everything made again.
func (s *windowShare) grab() (same bool, err error) {
	if sys(procIsWindow, s.hwnd) == 0 {
		return false, errWindowGone
	}
	r, ok := windowRect(s.hwnd)
	if !ok {
		return false, errWindowGone
	}
	if r.w() != s.rect.w() || r.h() != s.rect.h() {
		return false, nil
	}
	if sys(procIsIconic, s.hwnd) != 0 && s.lastGood {
		return true, nil
	}
	if !s.surface.printWindow(s.hwnd) {
		if s.lastGood {
			return true, nil
		}
		return true, errors.New("this window cannot be captured (it may belong to a program that runs as administrator)")
	}
	s.lastGood = true
	pix, stride, w, h, scale := s.surface.pixels(), s.rect.w()*4, s.rect.w(), s.rect.h(), 1.0
	if s.scaler != nil {
		s.scaler.scale(s.scaled, pix, stride)
		pix, stride, w, h, scale = s.scaled, s.w*4, s.w, s.h, float64(s.w)/float64(s.rect.w())
	}
	if shape, x, y, ok := s.pointer.visible(int(r.left), int(r.top), w, h, scale); ok {
		shape.blend(pix, stride, w, h, x, y, scale)
	}
	return true, s.enc.EncodeBGRA(pix, stride)
}

func (s *windowShare) loop() error {
	tick := time.NewTicker(time.Second / time.Duration(s.p.FPS))
	defer tick.Stop()
	for !s.c.closed.Load() {
		same, err := s.grab()
		if err != nil || !same {
			return err
		}
		<-tick.C
	}
	return nil
}

func (c *winCapture) runWindow(p CaptureParams, onAU func([]byte), ready chan<- error) {
	defer close(c.done)
	end, err := comSession()
	if err != nil {
		ready <- err
		return
	}
	defer end()
	c.deliver = onAU
	n, ok := parseSourceNumber(p.SourceID, KindWindow)
	if !ok {
		ready <- fmt.Errorf("%q is not a window", p.SourceID)
		return
	}
	first := true
	for !c.closed.Load() {
		s := &windowShare{c: c, p: p, hwnd: hwndOf(n)}
		err := s.build()
		if err == nil {
			if first {
				c.mode = "window capture, " + s.enc.Mode()
				ready <- nil
				first = false
			}
			err = s.loop()
		}
		s.release()
		if err == nil && !c.closed.Load() {
			continue // the window changed size
		}
		if err != nil && !c.closed.Load() {
			if first {
				ready <- err
				return
			}
			c.finish(err)
			return
		}
	}
	if first {
		ready <- errEncoderClosed
	}
}
