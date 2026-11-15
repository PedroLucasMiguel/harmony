// Package input snapshots the keyboard and mouse once per frame so components never talk to the window directly.
package input

import (
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/raw"
)

type State struct {
	MouseX, MouseY float32
	Moved          bool
	Pressed        bool
	RightPressed   bool
	Down           bool
	Released       bool
	Wheel          float32
	Typed          []rune
	Backspace      bool
	Delete         bool
	Enter          bool
	Tab            bool
	ShiftTab       bool
	Escape         bool
	Left, Right    bool
	KeyUp, KeyDown bool
	Shift          bool
	Dropped        []string
	Home, End      bool
	Paste          bool
	SelectAll      bool
	Copy, Cut      bool
	Undo, Redo     bool
	// Jump is the number, 1 to 9, of Ctrl (Command on a Mac) and a digit pressed this frame, else 0.
	Jump      int
	Alt, Ctrl bool
	Super     bool
	// Clicks is how many presses in a row this one is (1, 2 or 3) on the frame the button went down, else 0.
	Clicks int
}

// Active reports whether anything happened that a screen might react to.
func (s State) Active() bool {
	return s.Moved || s.Pressed || s.RightPressed || s.Down || s.Released || s.Wheel != 0 || len(s.Typed) > 0 ||
		s.Backspace || s.Delete || s.Enter || s.Tab || s.ShiftTab || s.Escape ||
		s.Left || s.Right || s.KeyUp || s.KeyDown || len(s.Dropped) > 0 || s.Home || s.End || s.Paste || s.SelectAll ||
		s.Copy || s.Cut || s.Undo || s.Redo || s.Jump != 0
}

// Continuous reports whether all that happened is what repeats while it lasts: the mouse moving, the wheel turning
// or a button held.
func (s State) Continuous() bool {
	s.Moved, s.Down, s.Wheel = false, false, 0
	return !s.Active()
}

// Poll reads what the window has gathered since the last poll; prev is the previous result, to tell if the mouse moved.
func Poll(prev State) State {
	mx, my := raw.GetMousePosition()
	s := State{
		MouseX: mx, MouseY: my,
		Moved:        mx != prev.MouseX || my != prev.MouseY,
		Pressed:      raw.IsMouseButtonPressed(rl.MouseButtonLeft),
		RightPressed: raw.IsMouseButtonPressed(rl.MouseButtonRight),
		Down:         raw.IsMouseButtonDown(rl.MouseButtonLeft),
		Released:     raw.IsMouseButtonReleased(rl.MouseButtonLeft),
		Wheel:        raw.GetMouseWheelMove(),
		Enter:        raw.IsKeyPressed(rl.KeyEnter) || raw.IsKeyPressed(rl.KeyKpEnter),
		Escape:       raw.IsKeyPressed(rl.KeyEscape),
	}
	for ch := raw.GetCharPressed(); ch != 0; ch = raw.GetCharPressed() {
		if ch >= 32 {
			s.Typed = append(s.Typed, ch)
		}
	}
	repeat := func(k int32) bool { return raw.IsKeyPressed(k) || raw.IsKeyPressedRepeat(k) }
	shift := raw.IsKeyDown(rl.KeyLeftShift) || raw.IsKeyDown(rl.KeyRightShift)
	command := raw.IsKeyDown(rl.KeyLeftControl) || raw.IsKeyDown(rl.KeyRightControl) || raw.IsKeyDown(rl.KeyLeftSuper) || raw.IsKeyDown(rl.KeyRightSuper)
	s.Backspace = repeat(rl.KeyBackspace)
	s.Delete = repeat(rl.KeyDelete)
	s.Left, s.Right = repeat(rl.KeyLeft), repeat(rl.KeyRight)
	s.KeyUp, s.KeyDown = repeat(rl.KeyUp), repeat(rl.KeyDown)
	s.Shift = shift
	if raw.IsFileDropped() {
		s.Dropped = rl.LoadDroppedFiles()
		rl.UnloadDroppedFiles()
	}
	s.Home, s.End = repeat(rl.KeyHome), repeat(rl.KeyEnd)
	s.Tab = raw.IsKeyPressed(rl.KeyTab) && !shift
	s.ShiftTab = raw.IsKeyPressed(rl.KeyTab) && shift
	s.Alt = raw.IsKeyDown(rl.KeyLeftAlt) || raw.IsKeyDown(rl.KeyRightAlt)
	s.Ctrl = raw.IsKeyDown(rl.KeyLeftControl) || raw.IsKeyDown(rl.KeyRightControl)
	s.Super = raw.IsKeyDown(rl.KeyLeftSuper) || raw.IsKeyDown(rl.KeyRightSuper)
	s.Paste = command && repeat(rl.KeyV)
	s.SelectAll = command && raw.IsKeyPressed(rl.KeyA)
	s.Copy = command && raw.IsKeyPressed(rl.KeyC)
	s.Cut = command && repeat(rl.KeyX)
	if command && repeat(rl.KeyZ) {
		s.Undo, s.Redo = !shift, shift
	}
	s.Redo = s.Redo || (command && repeat(rl.KeyY))
	if command && !shift && !s.Alt {
		for digit := range int32(9) {
			if raw.IsKeyPressed(rl.KeyOne + digit) {
				s.Jump = int(digit) + 1
			}
		}
	}
	if s.Pressed {
		s.Clicks = countClick(mx, my)
	}
	return s
}

const (
	multiClickGap  = 500 * time.Millisecond
	multiClickSlop = 6
)

var lastPress struct {
	at   time.Time
	x, y float32
	n    int
}

// countClick numbers a press: the second and third in quick succession in the same place are a double and a triple click.
func countClick(x, y float32) int {
	now := time.Now()
	near := now.Sub(lastPress.at) < multiClickGap && abs(x-lastPress.x) < multiClickSlop && abs(y-lastPress.y) < multiClickSlop
	if near {
		lastPress.n = min(lastPress.n+1, 3)
	} else {
		lastPress.n = 1
	}
	lastPress.at, lastPress.x, lastPress.y = now, x, y
	return lastPress.n
}

func abs(v float32) float32 {
	if v < 0 {
		return -v
	}
	return v
}
