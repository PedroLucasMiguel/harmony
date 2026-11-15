package emoji

import "testing"

func TestLookupPrefersAliases(t *testing.T) {
	if got, ok := Lookup("thumbsup"); !ok || got != "\U0001f44d" {
		t.Fatalf("thumbsup = %q, %v", got, ok)
	}
	if _, ok := Lookup("snail"); !ok {
		t.Fatal("a name from the list is not found")
	}
	if _, ok := Lookup("no_such_emoji"); ok {
		t.Fatal("an unknown name resolved")
	}
}

func TestQuery(t *testing.T) {
	for typed, want := range map[string]string{"  Face  Palm ": "face_palm", "a-b": "a_b", "!!": "", "fire": "fire"} {
		if got := Query(typed); got != want {
			t.Errorf("Query(%q) = %q, want %q", typed, got, want)
		}
	}
}

func TestSearchStopsAtLimit(t *testing.T) {
	if got := Search("face", 5, nil); len(got) != 5 {
		t.Fatalf("got %d results, want 5", len(got))
	}
}

func TestSectionsAreNotEmpty(t *testing.T) {
	sections := Sections()
	if len(sections) != 6 {
		t.Fatalf("got %d sections", len(sections))
	}
	for _, s := range sections {
		if len(s.Items) == 0 {
			t.Errorf("section %q is empty", s.Label)
		}
	}
}
