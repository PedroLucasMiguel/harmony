//go:build linux

package native

import (
	"errors"
	"os"
)

// startCapture opens the screen (the desktop's screen cast portal on Wayland, X11 shared memory otherwise) or a V4L2
// camera, and encodes what it sees with the Backend's encoder. listCameras is in linuxcapture_v4l2.go.
func startCapture(p CaptureParams, onAU func([]byte), onEnd func(error)) (Capture, error) {
	if p.Height < 2 || p.FPS < 1 || p.BitrateKbps < 1 {
		return nil, errors.New("capture needs a height, a frame rate and a bit rate")
	}
	switch p.Source {
	case Webcam:
		return openCamera(p, onAU, onEnd)
	case Screen:
		if os.Getenv("WAYLAND_DISPLAY") != "" || os.Getenv("XDG_SESSION_TYPE") == "wayland" {
			return startPortalScreen(p, onAU, onEnd)
		}
		return startX11(p, onAU, onEnd)
	}
	return nil, errors.New("unknown capture source")
}
