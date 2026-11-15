package widget

import (
	"image/color"
	"runtime"
	"unicode"

	"harmony/v2/internal/ui/emojitext"
	"harmony/v2/internal/ui/input"
	"harmony/v2/internal/ui/theme"
)

const undoDepth = 100

type editKind uint8

const (
	editNone editKind = iota
	editType
	editBackspace
	editDelete
	editOther
)

type snapshot struct {
	text          string
	caret, anchor int
}

type dragMode uint8

const (
	dragNone dragMode = iota
	dragChars
	dragWords
	dragLines
)

// textEdit is the caret, the selection and the undo history of one editable text; the text itself stays with the widget.
// The selection runs between anchor and caret, and the caret is the end that moves.
type textEdit struct {
	caret, anchor int
	undo, redo    []snapshot
	kind          editKind
	drag          dragMode
	dragFrom      int
	dragTo        int
}

// navigation tells the editor where a line begins and ends and what is above and below; without it the text is one line.
type navigation struct {
	lineStart, lineEnd func(i int) int
	vertical           func(i int, down bool) int
	paragraph          bool
}

func (n navigation) start(i int) int {
	if n.lineStart == nil {
		return 0
	}
	return n.lineStart(i)
}

func (n navigation) end(i, length int) int {
	if n.lineEnd == nil {
		return length
	}
	return n.lineEnd(i)
}

var macKeys = runtime.GOOS == "darwin"

func (e *textEdit) hasSelection() bool { return e.caret != e.anchor }

func (e *textEdit) span() (from, to int) {
	if e.caret < e.anchor {
		return e.caret, e.anchor
	}
	return e.anchor, e.caret
}

func (e *textEdit) clamp(n int) {
	e.caret, e.anchor = min(e.caret, n), min(e.anchor, n)
}

func (e *textEdit) place(i int) {
	e.caret, e.anchor, e.kind = i, i, editNone
}

func (e *textEdit) selectAll(n int) {
	e.anchor, e.caret, e.kind = 0, n, editNone
}

func (e *textEdit) selected(text []rune) []rune {
	from, to := e.span()
	return text[from:to]
}

func (e *textEdit) reset() {
	e.undo, e.redo, e.kind = e.undo[:0], e.redo[:0], editNone
}

// record keeps the text as it was before an edit, unless the edit goes on from the one before it (letters typed in a row are one step).
func (e *textEdit) record(text []rune, kind editKind) {
	if kind != editOther && kind == e.kind && !e.hasSelection() {
		return
	}
	e.undo = append(e.undo, snapshot{text: string(text), caret: e.caret, anchor: e.anchor})
	if len(e.undo) > undoDepth {
		e.undo = append(e.undo[:0], e.undo[len(e.undo)-undoDepth:]...)
	}
	e.redo = e.redo[:0]
}

// replace puts with in place of text[from:to], leaves the caret after it and returns the new text; limit caps its length when above zero.
func (e *textEdit) replace(text []rune, from, to int, with []rune, kind editKind, limit int) []rune {
	if limit > 0 {
		with = with[:min(len(with), max(0, limit-(len(text)-(to-from))))]
	}
	if from == to && len(with) == 0 {
		return text
	}
	e.record(text, kind)
	e.kind = kind
	out := make([]rune, 0, len(text)-(to-from)+len(with))
	out = append(append(append(out, text[:from]...), with...), text[to:]...)
	e.caret = from + len(with)
	e.anchor = e.caret
	return out
}

func (e *textEdit) swap(text []rune, from, to *[]snapshot) ([]rune, bool) {
	if len(*from) == 0 {
		return text, false
	}
	last := (*from)[len(*from)-1]
	*from = (*from)[:len(*from)-1]
	*to = append(*to, snapshot{text: string(text), caret: e.caret, anchor: e.anchor})
	e.caret, e.anchor, e.kind = last.caret, last.anchor, editNone
	return []rune(last.text), true
}

// keys applies what was typed and pressed to the text and returns it, changed or not. Copy and Cut hand the selected text to
// takeText; paste is what the clipboard holds, read only if a paste was asked for.
func (e *textEdit) keys(in input.State, text []rune, nav navigation, limit int, secret bool, paste func() string, takeText func(string)) ([]rune, bool) {
	e.clamp(len(text))
	changed := false
	apply := func(out []rune) {
		changed = changed || !sameRunes(out, text)
		text = out
	}
	if in.SelectAll {
		e.selectAll(len(text))
	}
	if in.Copy && e.hasSelection() && !secret {
		takeText(string(e.selected(text)))
	}
	if in.Cut && e.hasSelection() && !secret {
		takeText(string(e.selected(text)))
		from, to := e.span()
		apply(e.replace(text, from, to, nil, editOther, 0))
	}
	if in.Undo || in.Redo {
		from, to := &e.undo, &e.redo
		if in.Redo {
			from, to = to, from
		}
		if out, ok := e.swap(text, from, to); ok {
			text, changed = out, true
		}
	}
	if len(in.Typed) > 0 {
		from, to := e.span()
		apply(e.replace(text, from, to, in.Typed, editType, limit))
	}
	if in.Paste {
		if clip := paste(); clip != "" {
			from, to := e.span()
			apply(e.replace(text, from, to, []rune(clip), editOther, limit))
		}
	}
	if in.Enter && in.Shift && nav.paragraph {
		from, to := e.span()
		apply(e.replace(text, from, to, []rune{'\n'}, editOther, limit))
	}
	if in.Backspace || in.Delete {
		apply(e.erase(in, text, nav))
	}
	e.move(in, text, nav)
	return text, changed
}

func sameRunes(a, b []rune) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func wordKey(in input.State) bool {
	if macKeys {
		return in.Alt
	}
	return in.Ctrl
}

func lineKey(in input.State) bool { return macKeys && in.Super }

func (e *textEdit) erase(in input.State, text []rune, nav navigation) []rune {
	from, to := e.span()
	if from != to {
		return e.replace(text, from, to, nil, editOther, 0)
	}
	if in.Backspace {
		start := emojitext.PrevCluster(text, e.caret)
		switch {
		case lineKey(in):
			start = nav.start(e.caret)
			if start == e.caret {
				start = emojitext.PrevCluster(text, e.caret)
			}
		case wordKey(in):
			start = wordLeft(text, e.caret)
		}
		kind := editBackspace
		if start < e.caret-1 {
			kind = editOther
		}
		return e.replace(text, start, e.caret, nil, kind, 0)
	}
	end := emojitext.NextCluster(text, e.caret)
	switch {
	case lineKey(in):
		end = max(nav.end(e.caret, len(text)), end)
	case wordKey(in):
		end = wordRight(text, e.caret, true)
	}
	kind := editDelete
	if end > e.caret+1 {
		kind = editOther
	}
	return e.replace(text, e.caret, end, nil, kind, 0)
}

func (e *textEdit) move(in input.State, text []rune, nav navigation) {
	target, moved := e.caret, false
	collapse := !in.Shift && e.hasSelection()
	from, to := e.span()
	step := func(i int) {
		target, moved = i, true
	}
	switch {
	case in.Left:
		switch {
		case lineKey(in):
			step(nav.start(e.caret))
		case wordKey(in):
			step(wordLeft(text, e.caret))
		case collapse:
			step(from)
		default:
			step(emojitext.PrevCluster(text, e.caret))
		}
	case in.Right:
		switch {
		case lineKey(in):
			step(nav.end(e.caret, len(text)))
		case wordKey(in):
			step(wordRight(text, e.caret, macKeys || !runtimeWindows))
		case collapse:
			step(to)
		default:
			step(emojitext.NextCluster(text, e.caret))
		}
	case in.Home:
		if in.Ctrl && !macKeys {
			step(0)
		} else {
			step(nav.start(e.caret))
		}
	case in.End:
		if in.Ctrl && !macKeys {
			step(len(text))
		} else {
			step(nav.end(e.caret, len(text)))
		}
	case in.KeyUp && nav.vertical != nil:
		if lineKey(in) {
			step(0)
		} else {
			step(nav.vertical(e.caret, false))
		}
	case in.KeyDown && nav.vertical != nil:
		if lineKey(in) {
			step(len(text))
		} else {
			step(nav.vertical(e.caret, true))
		}
	}
	if !moved {
		return
	}
	e.caret, e.kind = target, editNone
	if !in.Shift {
		e.anchor = target
	}
}

var runtimeWindows = runtime.GOOS == "windows"

// press starts a selection at the character index i: a click puts the caret there, a double click takes the word and a triple click the line.
func (e *textEdit) press(clicks int, i int, extend bool, text []rune, nav navigation) {
	e.kind = editNone
	switch {
	case clicks >= 3:
		e.dragFrom, e.dragTo = lineAt(text, i, nav.paragraph)
		e.anchor, e.caret, e.drag = e.dragFrom, e.dragTo, dragLines
	case clicks == 2:
		e.dragFrom, e.dragTo = wordAt(text, i)
		e.anchor, e.caret, e.drag = e.dragFrom, e.dragTo, dragWords
	default:
		if !extend {
			e.anchor = i
		}
		e.caret, e.drag = i, dragChars
	}
}

// dragOver follows the pointer to character index i while a button is held.
func (e *textEdit) dragOver(i int, text []rune, nav navigation) {
	switch e.drag {
	case dragChars:
		e.caret = i
	case dragWords, dragLines:
		var from, to int
		if e.drag == dragWords {
			from, to = wordAt(text, i)
		} else {
			from, to = lineAt(text, i, nav.paragraph)
		}
		if i < e.dragFrom {
			e.caret, e.anchor = from, e.dragTo
		} else {
			e.caret, e.anchor = to, e.dragFrom
		}
	}
}

func isWordRune(r rune) bool {
	return r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r)
}

// wordLeft is the start of the word before i, skipping what separates words.
func wordLeft(text []rune, i int) int {
	i = min(i, len(text))
	for i > 0 && !isWordRune(text[i-1]) {
		i--
	}
	for i > 0 && isWordRune(text[i-1]) {
		i--
	}
	return i
}

// wordRight is the end of the word after i, or with toEnd false the start of the one after it.
func wordRight(text []rune, i int, toEnd bool) int {
	if toEnd {
		for i < len(text) && !isWordRune(text[i]) {
			i++
		}
		for i < len(text) && isWordRune(text[i]) {
			i++
		}
		return i
	}
	for i < len(text) && isWordRune(text[i]) {
		i++
	}
	for i < len(text) && !isWordRune(text[i]) {
		i++
	}
	return i
}

func runeClass(r rune) int {
	switch {
	case isWordRune(r):
		return 1
	case unicode.IsSpace(r):
		return 2
	}
	return 3
}

// wordAt is the word, the run of spaces or the run of marks that the character at i belongs to; a point just after a word is in that word.
func wordAt(text []rune, i int) (from, to int) {
	if len(text) == 0 {
		return 0, 0
	}
	i = min(i, len(text))
	at := min(i, len(text)-1)
	if i > 0 && (i == len(text) || runeClass(text[i-1]) == 1 && runeClass(text[at]) != 1) {
		at = i - 1
	}
	class := runeClass(text[at])
	from, to = at, at+1
	for from > 0 && runeClass(text[from-1]) == class {
		from--
	}
	for to < len(text) && runeClass(text[to]) == class {
		to++
	}
	if class == 3 {
		from, to = at, emojitext.NextCluster(text, at)
	}
	return from, to
}

// lineAt is the line of text around i: between line breaks when paragraph is set, else all of it.
func lineAt(text []rune, i int, paragraph bool) (from, to int) {
	if !paragraph {
		return 0, len(text)
	}
	i = min(i, len(text))
	from, to = i, i
	for from > 0 && text[from-1] != '\n' {
		from--
	}
	for to < len(text) && text[to] != '\n' {
		to++
	}
	return from, to
}

// editing is whether anything was pressed that a text being edited has to look at.
func editing(in input.State) bool {
	return len(in.Typed) > 0 || in.Backspace || in.Delete || in.Left || in.Right || in.Home || in.End || in.KeyUp || in.KeyDown ||
		in.Paste || in.SelectAll || in.Copy || in.Cut || in.Undo || in.Redo || in.Enter && in.Shift
}

func selectionColor(c *Context) color.RGBA { return theme.WithAlpha(c.Theme.Accent, selectionAlpha) }

const selectionAlpha = 0.42
