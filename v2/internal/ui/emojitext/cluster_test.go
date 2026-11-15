package emojitext

import (
	"slices"
	"testing"
)

func TestSegments(t *testing.T) {
	text := "Hi \U0001F468‍\U0001F469‍\U0001F467‍\U0001F466 \U0001F1E7\U0001F1F7\U0001F1EF\U0001F1F5 1️⃣ © ❤️ \U0001F44D\U0001F3FD end"
	var got []string
	runes := []rune(text)
	for _, s := range Segments(nil, text) {
		kind := "t"
		if s.Emoji {
			kind = "e"
		}
		got = append(got, kind+string(runes[s.From:s.To]))
	}
	want := []string{
		"tHi ", "e\U0001F468‍\U0001F469‍\U0001F467‍\U0001F466", "t ",
		"e\U0001F1E7\U0001F1F7", "e\U0001F1EF\U0001F1F5", "t ", "e1️⃣", "t © ", "e❤️", "t ",
		"e\U0001F44D\U0001F3FD", "t end",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("segments %q, want %q", got, want)
	}
	if MayContain("plain text, é and ü") {
		t.Fatal("text without emoji must skip segmentation")
	}
}

func TestClusterSteps(t *testing.T) {
	text := []rune("a\U0001F468‍\U0001F469é\U0001F1E7\U0001F1F7b")
	wantEnds := []int{1, 4, 6, 8, 9}
	if got := ClusterEnds(nil, text); !slices.Equal(got, wantEnds) {
		t.Fatalf("ends %v, want %v", got, wantEnds)
	}
	for i := 1; i < len(wantEnds); i++ {
		if got := NextCluster(text, wantEnds[i-1]); got != wantEnds[i] {
			t.Errorf("next after %d = %d, want %d", wantEnds[i-1], got, wantEnds[i])
		}
		if got := PrevCluster(text, wantEnds[i]); got != wantEnds[i-1] {
			t.Errorf("prev before %d = %d, want %d", wantEnds[i], got, wantEnds[i-1])
		}
	}
	if NextCluster(text, len(text)) != len(text) || PrevCluster(text, 0) != 0 {
		t.Error("steps must stop at the ends")
	}
}
