package channels

import "testing"

func TestMentionToken(t *testing.T) {
	cases := []struct {
		text string
		kind rune
		at   int
	}{
		{"hi @al", '@', 3},
		{"@", '@', 0},
		{"mail me@example", 0, -1},
		{"hi @al and", 0, -1},
		{"see #gen", '#', 4},
		{"see #gen.", 0, -1},
		{"a #b @c", '@', 5},
		{"@@x", 0, -1},
		{"x&#y", 0, -1},
	}
	for _, c := range cases {
		runes := []rune(c.text)
		at, kind := mentionToken(runes, len(runes))
		if at != c.at || kind != c.kind {
			t.Errorf("%q: got %d %q, want %d %q", c.text, at, kind, c.at, c.kind)
		}
	}
}

func TestHandles(t *testing.T) {
	for in, want := range map[string]string{"Game Night": "game-night", "Équipe  Ops!": "equipe-ops", "--x--": "x", "": ""} {
		if got := roleHandle(in); got != want {
			t.Errorf("roleHandle(%q) = %q, want %q", in, got, want)
		}
	}
	for in, want := range map[string]string{"Locked Room": "locked-room", "a.b": "ab", "General": "general"} {
		if got := channelHandle(in); got != want {
			t.Errorf("channelHandle(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestHugePaste(t *testing.T) {
	long := make([]rune, 4001)
	mid := make([]rune, 1500)
	for _, c := range []struct {
		text         []rune
		box, sel, lm int
		want         bool
	}{
		{long, 0, 0, 0, true},
		{make([]rune, 3999), 0, 0, 0, false},
		{mid, 3000, 0, 0, true},
		{mid, 3000, 600, 0, false},
		{make([]rune, 999), 3900, 0, 0, false},
		{mid, 0, 0, 1000, true},
	} {
		if got := hugePaste(c.text, c.box, c.sel, c.lm); got != c.want {
			t.Errorf("len %d box %d sel %d limit %d: got %v", len(c.text), c.box, c.sel, c.lm, got)
		}
	}
	if pastedName([]string{"message.txt", "message (2).txt"}) != "message (3).txt" || pastedName(nil) != "message.txt" {
		t.Error("pastedName")
	}
}
