package widget

import (
	"testing"

	"harmony/v2/internal/ui/input"
)

func run(e *textEdit, text string, in input.State) string {
	out, _ := e.keys(in, []rune(text), navigation{}, 0, false, func() string { return "" }, func(string) {})
	return string(out)
}

func TestWordMoves(t *testing.T) {
	text := []rune("foo, bar_baz  qux")
	cases := []struct{ from, left, right int }{
		{17, 14, 17},
		{14, 5, 17},
		{5, 0, 12},
		{3, 0, 12},
		{0, 0, 3},
	}
	for _, c := range cases {
		if got := wordLeft(text, c.from); got != c.left {
			t.Errorf("wordLeft(%d) = %d, want %d", c.from, got, c.left)
		}
		if got := wordRight(text, c.from, true); got != c.right {
			t.Errorf("wordRight(%d) = %d, want %d", c.from, got, c.right)
		}
	}
}

func TestWordAt(t *testing.T) {
	text := []rune("foo  bar!")
	for _, c := range []struct{ at, from, to int }{{1, 0, 3}, {3, 0, 3}, {4, 3, 5}, {6, 5, 8}, {8, 5, 8}, {9, 8, 9}} {
		if from, to := wordAt(text, c.at); from != c.from || to != c.to {
			t.Errorf("wordAt(%d) = %d,%d want %d,%d", c.at, from, to, c.from, c.to)
		}
	}
}

func TestShiftSelectionAndClusters(t *testing.T) {
	var e textEdit
	text := "a👨‍👩‍👧e\u0301"
	e.caret, e.anchor = 0, 0
	run(&e, text, input.State{Right: true, Shift: true})
	run(&e, text, input.State{Right: true, Shift: true})
	if from, to := e.span(); from != 0 || to != 6 {
		t.Fatalf("selection after two shift+right = %d,%d, want 0,6", from, to)
	}
	run(&e, text, input.State{Right: true, Shift: true})
	if _, to := e.span(); to != 8 {
		t.Fatalf("combining mark must stay with its letter: caret %d, want 8", to)
	}
	run(&e, text, input.State{Left: true})
	if e.caret != 0 || e.hasSelection() {
		t.Fatalf("left over a selection goes to its start: caret %d, selection %v", e.caret, e.hasSelection())
	}
}

func TestTypeReplacesSelectionAndUndoGroups(t *testing.T) {
	var e textEdit
	text := "hello world"
	e.anchor, e.caret = 0, 5
	text = run(&e, text, input.State{Typed: []rune("J")})
	if text != "J world" {
		t.Fatalf("got %q", text)
	}
	text = run(&e, text, input.State{Typed: []rune("i")})
	text = run(&e, text, input.State{Typed: []rune("!")})
	if text != "Ji! world" {
		t.Fatalf("got %q", text)
	}
	text = run(&e, text, input.State{Undo: true})
	if text != "hello world" {
		t.Fatalf("one undo undoes the typed run, got %q", text)
	}
	text = run(&e, text, input.State{Redo: true})
	if text != "Ji! world" {
		t.Fatalf("redo got %q", text)
	}
}

func TestBackspaceByWordAndLimit(t *testing.T) {
	var e textEdit
	e.place(11)
	if macKeys {
		text := run(&e, "hello world", input.State{Backspace: true, Alt: true})
		if text != "hello " {
			t.Fatalf("got %q", text)
		}
	} else {
		text := run(&e, "hello world", input.State{Backspace: true, Ctrl: true})
		if text != "hello " {
			t.Fatalf("got %q", text)
		}
	}
	e.place(3)
	out, _ := e.keys(input.State{Typed: []rune("xyz")}, []rune("abcde"), navigation{}, 6, false, func() string { return "" }, func(string) {})
	if string(out) != "abcxde" {
		t.Fatalf("limit: got %q", string(out))
	}
}

func TestSelectionAcrossTexts(t *testing.T) {
	var s TextSelection
	s.Press(10, 4, 1, 0, 0, false)
	s.Drag(30, 2, 0, 0)
	for id, want := range map[int][2]int{5: {0, 0}, 10: {4, 9}, 20: {0, 9}, 30: {0, 2}, 31: {0, 0}} {
		if from, to := s.Range(id, 9); from != want[0] || to != want[1] {
			t.Errorf("id %d: %d,%d want %v", id, from, to, want)
		}
	}
	s.Drag(10, 1, 0, 0)
	if from, to := s.Range(10, 9); from != 1 || to != 4 {
		t.Errorf("backwards: %d,%d", from, to)
	}
}
