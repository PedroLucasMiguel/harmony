package markdown

import "testing"

func TestShortcodeSpan(t *testing.T) {
	spans := Parse("hi :fire: there")[0].Lines[0]
	if len(spans) != 3 || spans[1].Flags&Emoji == 0 || spans[1].Text != ":fire:" {
		t.Fatalf("spans = %+v", spans)
	}
	if spans := Parse("12:30:45")[0].Lines[0]; len(spans) != 3 || spans[1].Text != ":30:" {
		t.Fatalf("a time is read as %+v", spans)
	}
	if spans := Parse("a :x: b")[0].Lines[0]; len(spans) != 1 {
		t.Fatalf("a one letter name is a shortcode: %+v", spans)
	}
}

func TestEmojiOnly(t *testing.T) {
	known := func(name string) bool { return name == "harmony" }
	for body, want := range map[string]bool{
		"\U0001f602\U0001f602":  true,
		" \U0001f44d ":          true,
		":harmony:":             true,
		":nope:":                false,
		"hi \U0001f602":         false,
		"":                      false,
		"::":                    false,
		"❤️":                    true,
		":harmony: \U0001f602 ": true,
	} {
		if got := EmojiOnly(body, known); got != want {
			t.Errorf("EmojiOnly(%q) = %v, want %v", body, got, want)
		}
	}
}
