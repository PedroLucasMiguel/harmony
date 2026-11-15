//go:build darwin

package native

// Screen and camera capture on macOS: ScreenCaptureKit and AVFoundation, called through purego, feeding the encoder in
// macencode_*.go with CVPixelBuffers. The screen is in maccapture_screen_darwin.go, the camera in
// maccapture_camera_darwin.go, what they share in maccapture_common_darwin.go.

import (
	"fmt"
	"time"
)

func startCapture(p CaptureParams, onAU func([]byte), onEnd func(error)) (Capture, error) {
	if err := mcLoad(); err != nil {
		return nil, err
	}
	if p.Height < 16 {
		return nil, fmt.Errorf("capture height %d is too small", p.Height)
	}
	if p.FPS <= 0 {
		p.FPS = 30
	}
	defer mcPool()()
	c := &macCapture{p: p, onAU: onAU, onEnd: onEnd, first: make(chan error, 1)}
	c.idle = time.AfterFunc(time.Hour, c.resend)
	c.idle.Stop()
	var err error
	switch p.Source {
	case Screen:
		err = c.startScreen()
	case Webcam:
		c.gap = int64(time.Second) / int64(p.FPS) * 9 / 10
		err = c.startCamera()
	default:
		err = fmt.Errorf("unknown capture source %q", p.Source)
	}
	if err != nil {
		c.shutdown()
		return nil, err
	}
	return c, nil
}
