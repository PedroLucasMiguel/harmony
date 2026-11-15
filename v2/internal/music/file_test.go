package music

import (
	"bytes"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"harmony/v2/internal/audio"
	"harmony/v2/internal/clip"
	"harmony/v2/internal/voicenote"
)

func recorded(t *testing.T, seconds int) string {
	t.Helper()
	rec, err := voicenote.NewRecorder()
	if err != nil {
		t.Fatal(err)
	}
	pcm := make([]int16, seconds*rate)
	for i := range pcm {
		pcm[i] = int16(8000 * math.Sin(2*math.Pi*440*float64(i)/rate))
	}
	for i := 0; i+960 <= len(pcm); i += 960 {
		rec.Feed(pcm[i : i+960])
	}
	for rec.Elapsed() < time.Duration(seconds)*time.Second {
		time.Sleep(time.Millisecond)
	}
	file, err := rec.Finish()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "track")
	if err := os.WriteFile(path, file.Data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestIndexFindsTheSamePacketsAsTheWholeFileReader(t *testing.T) {
	data, err := os.ReadFile("../voicenote/testdata/electron.webm")
	if err != nil {
		t.Fatal(err)
	}
	want, preSkip, err := clip.WebMOpus(data)
	if err != nil {
		t.Fatal(err)
	}
	got, gotSkip, err := clip.IndexWebMOpus(bytes.NewReader(data))
	if err != nil || gotSkip != preSkip || len(got) != len(want) {
		t.Fatalf("%d packets (skip %d, %v), want %d (skip %d)", len(got), gotSkip, err, len(want), preSkip)
	}
	for i, p := range got {
		if !bytes.Equal(data[p.Off:p.Off+int64(p.Size)], want[i]) {
			t.Fatalf("packet %d differs", i)
		}
	}
}

func TestFileSeeksAndReads(t *testing.T) {
	f, err := OpenFile(recorded(t, 3))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if math.Abs(float64(f.Frames()-3*rate)) > 960 {
		t.Fatalf("length %d frames", f.Frames())
	}
	buf := make([]int16, 2*960)
	f.Seek(rate)
	if n := f.Read(buf); n != 960 || f.Pos() != rate+960 {
		t.Fatalf("read %d frames, now at %d", n, f.Pos())
	}
	var peak int16
	for _, v := range buf {
		peak = max(peak, v)
	}
	if peak < 4000 {
		t.Fatalf("a steady tone read after a seek has peak %d", peak)
	}
	f.Seek(f.Frames() - 100)
	total := 0
	for n := f.Read(buf); n > 0; n = f.Read(buf) {
		total += n
	}
	if total < 90 || total > 110 {
		t.Fatalf("the last frames read were %d, want about 100", total)
	}
}

func TestPlayerFollowsTheTargetAndMovesWhenFarOff(t *testing.T) {
	path := recorded(t, 3)
	mixer := audio.NewMixer()
	p := NewPlayer(mixer)
	defer p.Stop()
	if err := p.Update(Want{Key: "a", Path: path, Playing: true, Gain: 1}, time.Second); err != nil {
		t.Fatal(err)
	}
	heard, ok := p.Heard()
	if !ok || heard < 950*time.Millisecond || heard > 1050*time.Millisecond {
		t.Fatalf("started at %v (sounding %v)", heard, ok)
	}
	out := make([]int16, 480*2)
	for range 20 {
		mixer.Mix(out)
		time.Sleep(10 * time.Millisecond)
	}
	if err := p.Update(Want{Key: "a", Path: path, Playing: true, Gain: 1}, 1200*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	before, _ := p.Heard()
	if err := p.Update(Want{Key: "a", Path: path, Playing: true, Gain: 1}, 2*time.Second); err != nil {
		t.Fatal(err)
	}
	after, _ := p.Heard()
	if after < 1950*time.Millisecond || after > 2050*time.Millisecond || before > 1500*time.Millisecond {
		t.Fatalf("a small difference moved it to %v, a large one to %v", before, after)
	}
	if err := p.Update(Want{Key: "a", Path: path, Playing: false, Gain: 1}, 2*time.Second); err != nil {
		t.Fatal(err)
	}
	if _, ok := p.Heard(); ok {
		t.Fatal("paused music still sounds")
	}
}
