package audio

import "testing"

func TestApplyGainClipsInsteadOfWrapping(t *testing.T) {
	pcm := []int16{1000, -1000, 30000, -30000}
	ApplyGain(pcm, 2)
	want := []int16{2000, -2000, 32767, -32768}
	for i := range want {
		if pcm[i] != want[i] {
			t.Fatalf("sample %d = %d, want %d", i, pcm[i], want[i])
		}
	}
	ApplyGain(pcm, 0)
	for i, v := range pcm {
		if v != 0 {
			t.Fatalf("sample %d = %d at zero gain", i, v)
		}
	}
}
