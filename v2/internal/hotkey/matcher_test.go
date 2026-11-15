package hotkey

import "testing"

func TestMatcherHoldsAndReleases(t *testing.T) {
	m := &matcher{combo: Combo{Ctrl: true, Key: "V"}, codes: []uint32{86}}
	ctrl, none := modifierState{ctrl: true}, modifierState{}
	if m.down(86, none) {
		t.Fatal("a bare V must not answer to Ctrl+V")
	}
	if !m.down(86, ctrl) || m.down(86, ctrl) {
		t.Fatal("pressing is reported once however long the key repeats")
	}
	if !m.up(17, none) {
		t.Fatal("letting go of Ctrl first ends the hold")
	}
	if m.up(86, ctrl) {
		t.Fatal("nothing is held any more")
	}
}

func TestParseAndFormat(t *testing.T) {
	c, ok := Parse("Ctrl+Shift+num7")
	if !ok || !c.Ctrl || !c.Shift || c.Key != "num7" {
		t.Fatalf("parsed %+v %v", c, ok)
	}
	if c, ok := Parse("Alt+Mouse4"); !ok || c.Mouse() != 4 || !c.Alt {
		t.Fatalf("a thumb button parses: %+v", c)
	}
	if _, ok := Parse("Mouse1"); ok {
		t.Fatal("the left button is never a binding")
	}
	if _, ok := Parse("Hyper+V"); ok {
		t.Fatal("unknown modifier")
	}
	if got := Format("Ctrl+Mouse4"); got != "Ctrl + Mouse back" {
		t.Fatal(got)
	}
	if Check(Combo{Key: "V"}, false, false) != "needs_modifier" || Check(Combo{Key: "F13"}, false, false) != "" {
		t.Fatal("a bare letter needs a modifier, an F-key does not")
	}
}
