package video

import (
	"testing"
	"time"
)

func TestIsBlack(t *testing.T) {
	const w, h = 16, 12
	frame := make([]byte, w*h*4)
	if !IsBlack(frame, w, h) {
		t.Fatal("an all black picture is black")
	}
	for i := 0; i < len(frame); i += 4 {
		frame[i], frame[i+1], frame[i+2] = byte(1+i/4%3), byte(1+i/4%2), 1
	}
	if !IsBlack(frame, w, h) {
		t.Fatal("a picture of faint noise is still black")
	}
	for i := 0; i < len(frame); i += 4 {
		frame[i], frame[i+1], frame[i+2] = 30, 30, 30
	}
	if IsBlack(frame, w, h) {
		t.Fatal("a dark grey picture is not black")
	}
	for i := range frame {
		frame[i] = 0
	}
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			frame[(y*w+x)*4+1] = 200
		}
	}
	if IsBlack(frame, w, h) {
		t.Fatal("a bright picture is not black")
	}
}

func watchSource(t *testing.T, source string) (black, lit bool) {
	t.Helper()
	capture, err := StartCapture(CaptureOptions{Source: source, Height: 180, FPS: 30, BitrateKbps: 500})
	if err != nil {
		t.Skipf("no encoder here: %v", err)
	}
	defer capture.Close()
	p := &BlackProbe{RequestKeyFrame: capture.KeyFrame}
	defer p.Close()
	end := time.Now().Add(3 * time.Second)
	for time.Now().Before(end) && !p.Lit() {
		au, err := capture.NextAU()
		if err != nil {
			break
		}
		p.Feed(au)
		if source == "black" && p.pictures.Load() >= 10 {
			break
		}
	}
	return p.Verdict(), p.Lit()
}

func TestBlackProbeSeesTheSyntheticSources(t *testing.T) {
	if black, _ := watchSource(t, "black"); !black {
		t.Error("the black source is not seen as black")
	}
	if black, lit := watchSource(t, "bars"); black || !lit {
		t.Errorf("the colour bars are seen as black=%v lit=%v", black, lit)
	}
}
