package sharegov

import (
	"testing"
	"time"
)

type feeder struct {
	g      *Governor
	at     time.Time
	frames uint64
	enc    float64
}

func (f *feeder) run(seconds int, fps float64, encodeMs float64) (changes []Plan) {
	for range seconds {
		f.at = f.at.Add(time.Second)
		f.frames += uint64(fps)
		f.enc += fps * encodeMs / 1000
		if p := f.g.Sample(Sample{At: f.at, Frames: f.frames, EncodeSeconds: f.enc, Width: 1920, Height: 1080}); p != nil {
			changes = append(changes, *p)
		}
	}
	return changes
}

func TestStarvedShareStepsDownFrameRateFirst(t *testing.T) {
	f := &feeder{g: New(Ask{FPS: 60, Width: 1920, Height: 1080}, Sharp), at: time.Unix(0, 0)}
	got := f.run(11, 12, 90)
	if len(got) != 1 || got[0].FPS != 30 || got[0].Height != 1080 || !got[0].Lowered {
		t.Fatalf("got %+v", got)
	}
}

func TestSmoothKeepsFrameRate(t *testing.T) {
	f := &feeder{g: New(Ask{FPS: 60, Width: 1920, Height: 1080}, Smooth), at: time.Unix(0, 0)}
	got := f.run(11, 12, 90)
	if len(got) != 1 || got[0].FPS != 60 || got[0].Height != 720 {
		t.Fatalf("got %+v", got)
	}
}

func TestIdleScreenAndLinkAreNotStarvation(t *testing.T) {
	f := &feeder{g: New(Ask{FPS: 60, Width: 1920, Height: 1080}, Sharp), at: time.Unix(0, 0)}
	if got := f.run(30, 0, 0); len(got) != 0 {
		t.Fatalf("an idle screen lowered the share: %+v", got)
	}
	if got := f.run(30, 50, 3); len(got) != 0 {
		t.Fatalf("a healthy encoder lowered the share: %+v", got)
	}
}

func TestRecoversAfterHalfAMinute(t *testing.T) {
	f := &feeder{g: New(Ask{FPS: 60, Width: 1920, Height: 1080}, Sharp), at: time.Unix(0, 0)}
	f.run(11, 12, 90)
	got := f.run(60, 30, 4)
	if len(got) != 1 || got[0].Lowered {
		t.Fatalf("got %+v", got)
	}
}
