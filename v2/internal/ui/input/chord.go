package input

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/raw"
)

// Chord is a key or mouse button with the modifiers held while it was pressed, as the hotkey dialog records them.
type Chord struct {
	Ctrl, Alt, Shift, Meta bool
	// Key is the key's name as an accelerator writes it ("V", "F13", "Space", "Up", "num7", "Mouse4"), empty while only modifiers are down.
	Key string
}

// ReadChord reports what is held now and, when a key or button went down since the last call, which; down is false when nothing new was pressed.
func ReadChord() (c Chord, down bool) {
	c.Ctrl = raw.IsKeyDown(rl.KeyLeftControl) || raw.IsKeyDown(rl.KeyRightControl)
	c.Alt = raw.IsKeyDown(rl.KeyLeftAlt) || raw.IsKeyDown(rl.KeyRightAlt)
	c.Shift = raw.IsKeyDown(rl.KeyLeftShift) || raw.IsKeyDown(rl.KeyRightShift)
	c.Meta = raw.IsKeyDown(rl.KeyLeftSuper) || raw.IsKeyDown(rl.KeyRightSuper)
	for _, b := range []struct {
		button rl.MouseButton
		name   string
	}{{rl.MouseButtonMiddle, "Mouse3"}, {rl.MouseButtonSide, "Mouse4"}, {rl.MouseButtonExtra, "Mouse5"}} {
		if raw.IsMouseButtonPressed(b.button) {
			c.Key, down = b.name, true
		}
	}
	for key := raw.GetKeyPressed(); key != 0; key = raw.GetKeyPressed() {
		if name := KeyName(key); name != "" {
			c.Key, down = name, true
		}
	}
	return c, down
}

var keyNames = map[int32]string{
	rl.KeySpace: "Space", rl.KeyTab: "Tab", rl.KeyEnter: "Enter", rl.KeyBackspace: "Backspace", rl.KeyDelete: "Delete",
	rl.KeyInsert: "Insert", rl.KeyHome: "Home", rl.KeyEnd: "End", rl.KeyPageUp: "PageUp", rl.KeyPageDown: "PageDown",
	rl.KeyUp: "Up", rl.KeyDown: "Down", rl.KeyLeft: "Left", rl.KeyRight: "Right",
	rl.KeyScrollLock: "Scrolllock", rl.KeyPrintScreen: "PrintScreen", rl.KeyCapsLock: "Capslock", rl.KeyNumLock: "Numlock",
	rl.KeyMinus: "-", rl.KeyEqual: "=", rl.KeyLeftBracket: "[", rl.KeyRightBracket: "]", rl.KeyBackSlash: "\\",
	rl.KeySemicolon: ";", rl.KeyApostrophe: "'", rl.KeyComma: ",", rl.KeyPeriod: ".", rl.KeySlash: "/", rl.KeyGrave: "`",
	rl.KeyKpAdd: "numadd", rl.KeyKpSubtract: "numsub", rl.KeyKpMultiply: "nummult", rl.KeyKpDivide: "numdiv",
	rl.KeyKpDecimal: "numdec", rl.KeyKpEnter: "numenter",
}

// KeyName is the accelerator name of a window key code, or "" for a key a hotkey cannot be (the modifiers by themselves, keys this system has no name for).
func KeyName(key int32) string {
	switch {
	case key >= rl.KeyA && key <= rl.KeyZ:
		return string(rune('A' + key - rl.KeyA))
	case key >= rl.KeyZero && key <= rl.KeyNine:
		return string(rune('0' + key - rl.KeyZero))
	case key >= rl.KeyF1 && key <= rl.KeyF12:
		return "F" + itoa(int(key-rl.KeyF1)+1)
	case key >= glfwF13 && key <= glfwF24:
		return "F" + itoa(int(key-glfwF13)+13)
	case key >= rl.KeyKp0 && key <= rl.KeyKp9:
		return "num" + itoa(int(key-rl.KeyKp0))
	}
	return keyNames[key]
}

const (
	glfwF13 = 302
	glfwF24 = 313
)

func itoa(n int) string {
	if n >= 10 {
		return itoa(n/10) + string(rune('0'+n%10))
	}
	return string(rune('0' + n))
}
