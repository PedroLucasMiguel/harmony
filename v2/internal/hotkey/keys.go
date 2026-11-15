package hotkey

import (
	"regexp"
	"strings"
)

// Combo is an accelerator taken apart: modifiers and one key, or one mouse button written "Mouse4".
type Combo struct {
	Ctrl, Alt, Shift, Meta bool
	Key                    string
}

var (
	letterOrDigit = regexp.MustCompile(`^([A-Z]|\d)$`)
	functionKey   = regexp.MustCompile(`^F([1-9]|1\d|2[0-4])$`)
	numpadDigit   = regexp.MustCompile(`^num\d$`)
	mouseButton   = regexp.MustCompile(`^Mouse(\d+)$`)
)

var namedKeys = map[string]bool{
	"Space": true, "Tab": true, "Enter": true, "Backspace": true, "Delete": true, "Insert": true, "Home": true, "End": true,
	"PageUp": true, "PageDown": true, "Up": true, "Down": true, "Left": true, "Right": true, "Scrolllock": true,
	"PrintScreen": true, "Capslock": true, "Numlock": true, "-": true, "=": true, "[": true, "]": true, "\\": true,
	";": true, "'": true, ",": true, ".": true, "/": true, "`": true,
	"numadd": true, "numsub": true, "nummult": true, "numdiv": true, "numdec": true, "numenter": true,
	"MediaPlayPause": true, "MediaNextTrack": true, "MediaPreviousTrack": true, "MediaStop": true,
	"VolumeMute": true, "VolumeUp": true, "VolumeDown": true,
}

var modifiers = map[string]func(*Combo){
	"ctrl": func(c *Combo) { c.Ctrl = true }, "control": func(c *Combo) { c.Ctrl = true },
	"alt": func(c *Combo) { c.Alt = true }, "option": func(c *Combo) { c.Alt = true },
	"shift":   func(c *Combo) { c.Shift = true },
	"command": func(c *Combo) { c.Meta = true }, "cmd": func(c *Combo) { c.Meta = true }, "super": func(c *Combo) { c.Meta = true },
	"meta": func(c *Combo) { c.Meta = true }, "win": func(c *Combo) { c.Meta = true },
}

// Parse reads an accelerator as the capture dialog writes it: "Ctrl+Shift+V", "F13", "Space", "Alt+Mouse4".
func Parse(accelerator string) (Combo, bool) {
	var c Combo
	parts := strings.Split(strings.TrimSpace(accelerator), "+")
	// The key "+" itself would split into two empty parts; it is not a key this vocabulary has.
	key := strings.TrimSpace(parts[len(parts)-1])
	for _, p := range parts[:len(parts)-1] {
		set, ok := modifiers[strings.ToLower(strings.TrimSpace(p))]
		if !ok {
			return Combo{}, false
		}
		set(&c)
	}
	c.Key = key
	switch {
	case letterOrDigit.MatchString(key), functionKey.MatchString(key), numpadDigit.MatchString(key), namedKeys[key]:
	case mouseButton.MatchString(key):
		if c.Mouse() < 3 {
			return Combo{}, false
		}
	default:
		return Combo{}, false
	}
	return c, true
}

// Mouse is the number of the button, 3 being the middle one, 4 back and 5 forward; 0 when the combo is a key.
func (c Combo) Mouse() int {
	m := mouseButton.FindStringSubmatch(c.Key)
	if m == nil {
		return 0
	}
	n := 0
	for _, d := range m[1] {
		n = n*10 + int(d-'0')
	}
	return n
}

var displayNames = map[string]string{
	"numadd": "Num +", "numsub": "Num -", "nummult": "Num *", "numdiv": "Num /", "numdec": "Num .", "numenter": "Num Enter",
	"Numlock": "Num Lock", "Mouse3": "Middle button", "Mouse4": "Mouse back", "Mouse5": "Mouse forward",
	"Scrolllock": "Scroll Lock", "PrintScreen": "Print Screen", "MediaPlayPause": "Play/Pause",
	"MediaNextTrack": "Next track", "MediaPreviousTrack": "Previous track", "MediaStop": "Stop",
	"VolumeMute": "Volume mute", "VolumeUp": "Volume up", "VolumeDown": "Volume down", "Super": "Win",
}

// Format is an accelerator as it reads on a button.
func Format(accelerator string) string {
	if accelerator == "" {
		return ""
	}
	parts := strings.Split(accelerator, "+")
	for i, p := range parts {
		switch {
		case displayNames[p] != "":
			parts[i] = displayNames[p]
		case numpadDigit.MatchString(p):
			parts[i] = "Num " + p[3:]
		case mouseButton.MatchString(p):
			parts[i] = "Mouse " + p[5:]
		}
	}
	return strings.Join(parts, " + ")
}

// Build writes a combination as an accelerator, modifiers first in the order Ctrl, Alt, Shift, then Command (Super off the Mac).
func Build(ctrl, alt, shift, meta bool, key string, mac bool) string {
	var parts []string
	if ctrl {
		parts = append(parts, "Ctrl")
	}
	if alt {
		parts = append(parts, "Alt")
	}
	if shift {
		parts = append(parts, "Shift")
	}
	if meta {
		if mac {
			parts = append(parts, "Command")
		} else {
			parts = append(parts, "Super")
		}
	}
	if key != "" {
		parts = append(parts, key)
	}
	return strings.Join(parts, "+")
}

var standalone = regexp.MustCompile(`^(F([1-9]|1\d|2[0-4])|num\w+|Mouse\d+|Media\w+|Volume\w+|Insert|Scrolllock|PrintScreen)$`)

// Check says what is wrong with a combination for a global shortcut that takes its keys from other programs, or "" when it is fine.
// Push to talk only listens, so it may be any key (allowBare). The codes are Electron's, for the matching i18n keys.
func Check(c Combo, allowBare, mac bool) string {
	if allowBare {
		return ""
	}
	if mac && c.Alt && !c.Ctrl && !c.Meta {
		return "mac_option"
	}
	if !(c.Ctrl || c.Alt || c.Meta) && !standalone.MatchString(c.Key) {
		return "needs_modifier"
	}
	return ""
}
