package paint

import "testing"

// A system without any of the fonts the program looks for still gets text: the built-in faces open and have glyphs.
func TestEmbeddedFacesOpen(t *testing.T) {
	byPath := map[string]*typeface{}
	for _, w := range []Weight{Regular, Medium, Semibold, Bold} {
		tf, err := openEmbedded(w, byPath)
		if err != nil {
			t.Fatalf("weight %d: %v", w, err)
		}
		if g, ok := tf.face.NominalGlyph('A'); !ok || g == 0 {
			t.Errorf("weight %d has no A", w)
		}
		if _, ok := tf.face.NominalGlyph('ç'); !ok {
			t.Errorf("weight %d has no ç", w)
		}
	}
	if len(byPath) != 3 {
		t.Errorf("regular and medium share a file: %d faces opened, want 3", len(byPath))
	}
}
