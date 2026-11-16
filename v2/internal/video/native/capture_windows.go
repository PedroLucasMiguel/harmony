//go:build windows

// Screen and camera capture on Windows, encoded: the screen through DXGI Desktop Duplication (wincapture_screen.go), cameras
// through the Media Foundation source reader (wincapture_camera.go). Both feed this package's Media Foundation encoder.
package native

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

const captureCloseWait = 3 * time.Second

// winCapture is what both captures share: the goroutine that runs them, the end notice, and Close.
type winCapture struct {
	mode    string
	deliver func([]byte)
	enc     atomic.Pointer[mftEncoder]
	closed  atomic.Bool
	done    chan struct{}
	onEnd   func(error)
	endOnce sync.Once
}

func (c *winCapture) Mode() string { return c.mode }

// KeyFrame makes the running encoder send a key frame with its next picture.
func (c *winCapture) KeyFrame() {
	if e := c.enc.Load(); e != nil {
		e.KeyFrame()
	}
}

// Close stops the capture and waits for its goroutine, which releases the device and the encoder.
func (c *winCapture) Close() {
	if c.closed.Swap(true) {
		return
	}
	select {
	case <-c.done:
	case <-time.After(captureCloseWait):
	}
}

// finish reports that the capture stopped by itself, once, and never after Close.
func (c *winCapture) finish(err error) {
	if c.closed.Load() || err == nil {
		return
	}
	c.endOnce.Do(func() { go c.onEnd(err) })
}

func startCapture(p CaptureParams, onAU func([]byte), onEnd func(error)) (Capture, error) {
	if p.Height <= 0 || p.FPS <= 0 || p.BitrateKbps <= 0 {
		return nil, fmt.Errorf("capture of %d lines at %d fps and %d kbps must have positive numbers", p.Height, p.FPS, p.BitrateKbps)
	}
	c := &winCapture{done: make(chan struct{}), onEnd: onEnd}
	guarded := func(au []byte) {
		if !c.closed.Load() {
			onAU(au)
		}
	}
	ready := make(chan error, 1)
	switch p.Source {
	case Screen:
		if kind, _ := ParseSourceID(p.SourceID); kind == KindWindow {
			go c.runWindow(p, guarded, ready)
		} else {
			go c.runScreen(p, guarded, ready)
		}
	case Webcam:
		go c.runCamera(p, guarded, ready)
	default:
		return nil, fmt.Errorf("unknown capture source %q", p.Source)
	}
	var wait <-chan time.Time
	if p.Source == Webcam {
		wait = time.After(cameraFirstFrameWait)
	}
	select {
	case err := <-ready:
		if err != nil {
			return nil, err
		}
	case <-wait:
		go c.Close()
		return nil, errors.New("the camera sent no picture: it may be in use by another program, or blocked in Windows Settings > Privacy & security > Camera")
	}
	return c, nil
}

func listCameras() []CameraInfo {
	var list []CameraInfo
	done := make(chan struct{})
	go func() {
		defer close(done)
		end, err := comSession()
		if err != nil {
			return
		}
		defer end()
		acts, err := mfEnumVideoCaptureDevices()
		if err != nil {
			return
		}
		for _, a := range acts {
			id, _, _ := a.getString(&weMFDevSymbolicLink)
			name, _, _ := a.getString(&weMFDevFriendlyName)
			if id != "" {
				list = append(list, CameraInfo{ID: id, Name: name})
			}
			a.release()
		}
	}()
	<-done
	return list
}
