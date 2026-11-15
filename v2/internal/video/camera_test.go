package video

import "testing"

func TestCameraBitrate(t *testing.T) {
	if got := CameraBitrateKbps(360, 24); got != 414 {
		t.Errorf("360p24: got %d kbps", got)
	}
	if got := CameraBitrateKbps(2160, 120); got != cameraMaxKbps {
		t.Errorf("4K120 should be capped, got %d", got)
	}
}

func TestNativeCameraMode(t *testing.T) {
	c920 := []CameraFormat{{W: 640, H: 480, MaxFPS: 30}, {W: 1280, H: 720, MaxFPS: 30}, {W: 1920, H: 1080, MaxFPS: 30}, {W: 2304, H: 1536, MaxFPS: 2}}
	if h, f, _ := bestMode(c920, 0); h != 1080 || f != 30 {
		t.Errorf("native on a camera whose biggest mode is a slideshow: %dp%d, want 1080p30", h, f)
	}
	if h, f, _ := bestMode(c920, 60); h != 1080 || f != 30 {
		t.Errorf("60 fps wanted from a 30 fps camera: %dp%d, want the rate lowered to 30 at 1080p", h, f)
	}
	fast := []CameraFormat{{W: 1920, H: 1080, MaxFPS: 30}, {W: 1280, H: 720, MaxFPS: 120}}
	if h, f, _ := bestMode(fast, 60); h != 720 || f != 60 {
		t.Errorf("60 fps wanted: %dp%d, want 720p60", h, f)
	}
	if h, f, _ := bestMode(fast, 0); h != 1080 || f != 30 {
		t.Errorf("native rate: %dp%d, want the biggest picture that holds 30", h, f)
	}
	if h, f := resolveMode(nil, 0, 0); h != 720 || f != 30 {
		t.Errorf("nothing known: %dp%d, want 720p30", h, f)
	}
	if h, f := resolveMode(fast, 720, 0); h != 720 || f != 60 {
		t.Errorf("fixed size, native rate: %dp%d, want the fastest rate at or above 720p, capped at 60", h, f)
	}
}
