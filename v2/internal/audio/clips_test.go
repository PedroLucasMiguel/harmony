package audio

import "testing"

func TestClipPlaysToTheEndAndIsDropped(t *testing.T) {
	m := NewMixer()
	m.PlayClip([]int16{1000, 1000, 2000, 2000, 3000, 3000}, 0.5)
	out := make([]int16, 4)
	m.Mix(out)
	if out[0] != 500 || out[2] != 1000 {
		t.Fatalf("first block %v", out)
	}
	m.Mix(out)
	if out[0] != 1500 || out[2] != 0 {
		t.Fatalf("second block %v", out)
	}
	if len(m.clips) != 0 {
		t.Fatal("a finished clip should be dropped")
	}
}
