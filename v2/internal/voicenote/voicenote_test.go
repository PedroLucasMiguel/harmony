package voicenote

import (
	"math"
	"os"
	"testing"
	"time"

	"harmony/v2/internal/clip"
)

func tone(frames int) []int16 {
	pcm := make([]int16, frames)
	for i := range pcm {
		pcm[i] = int16(8000 * math.Sin(2*math.Pi*440*float64(i)/rate))
	}
	return pcm
}

func TestRecordedFileRoundTrips(t *testing.T) {
	rec, err := NewRecorder()
	if err != nil {
		t.Fatal(err)
	}
	const seconds = 3
	pcm := tone(seconds * rate)
	for i := 0; i < len(pcm); i += frame {
		rec.Feed(pcm[i : i+frame])
	}
	for rec.Elapsed() < seconds*time.Second {
		time.Sleep(time.Millisecond)
	}
	file, err := rec.Finish()
	if err != nil {
		t.Fatal(err)
	}
	packets, preSkip, err := clip.WebMOpus(file.Data)
	if err != nil || len(packets) != seconds*50 || preSkip == 0 {
		t.Fatalf("demuxed %d packets, pre-skip %d, err %v", len(packets), preSkip, err)
	}
	track, err := Open(file.Data)
	if err != nil {
		t.Fatal(err)
	}
	if got := track.Frames(); math.Abs(float64(got-seconds*rate)) > frame {
		t.Fatalf("length %d frames, want about %d", got, seconds*rate)
	}
	info := Analyse(track)
	if info.Peaks[Bars/2] < 200 {
		t.Fatalf("a steady tone should have full bars: %v", info.Peaks)
	}
	buf := make([]int16, 2*frame)
	track.Seek(rate)
	if n := track.Read(buf); n != frame || math.Abs(float64(buf[2*100])) < 1000 {
		t.Fatalf("read after seek gave %d frames, sample %d", n, buf[200])
	}
}

func TestElectronRecordingDecodes(t *testing.T) {
	data, err := os.ReadFile("testdata/electron.webm")
	if err != nil {
		t.Fatal(err)
	}
	track, err := Open(data)
	if err != nil {
		t.Fatal(err)
	}
	if seconds := float64(track.Frames()) / rate; seconds < 4.5 || seconds > 5.5 {
		t.Fatalf("a five second recording came out %.2f s long", seconds)
	}
	info := Analyse(track)
	if info.Peaks == ([Bars]byte{}) {
		t.Fatal("no waveform")
	}
}

func TestSpeedShortensWithoutChangingPitch(t *testing.T) {
	r := newReader(&pcmTrack{pcm: stereo(tone(2 * rate))})
	r.SetSpeed(2)
	buf := make([]int16, 2*rate)
	total, crossings := 0, 0
	for {
		n := r.Read(buf)
		if n == 0 {
			break
		}
		for i := 1; i < n; i++ {
			if (buf[2*i-2] < 0) != (buf[2*i] < 0) {
				crossings++
			}
		}
		total += n
	}
	if math.Abs(float64(total)-rate) > rate/20 {
		t.Fatalf("two seconds at double speed came out %d frames", total)
	}
	if hz := float64(crossings) / 2 / (float64(total) / rate); math.Abs(hz-440) > 15 {
		t.Fatalf("pitch moved to %.0f Hz", hz)
	}
}

func stereo(mono []int16) []int16 {
	out := make([]int16, 2*len(mono))
	for i, v := range mono {
		out[2*i], out[2*i+1] = v, v
	}
	return out
}
