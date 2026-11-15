package shell

import (
	"runtime"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/store"
	"harmony/v2/internal/ui/raw"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/theme"
)

const (
	zoomMin     = 70
	zoomMax     = 180
	zoomStep    = 5
	zoomDefault = 115
)

// paletteOf is the palette the settings name, the custom one made from the person's four colours when that is chosen.
func paletteOf(s *store.Settings) theme.Palette {
	if s.Theme == theme.CustomName && s.CustomTheme != nil {
		return theme.Custom(theme.Colours(*s.CustomTheme))
	}
	return theme.ByName(s.Theme)
}

func repeated(key int32) bool { return raw.IsKeyPressed(key) || raw.IsKeyPressedRepeat(key) }

// shortcuts handles the keys that belong to the window: interface size (Ctrl or Cmd with plus, minus, zero), back and forward (Cmd with [ and ] on a Mac, Alt with the arrows elsewhere) and quit (Alt+F4 off a Mac). It runs once per input poll.
func (sh *Shell) shortcuts() {
	mac := runtime.GOOS == "darwin"
	in := sh.in
	primary := in.Ctrl && !in.Super
	if mac {
		primary = in.Super && !in.Ctrl
	}
	switch {
	case primary && !in.Alt && (repeated(rl.KeyEqual) || repeated(rl.KeyKpAdd)):
		sh.nudgeZoom(zoomStep)
	case primary && !in.Alt && (repeated(rl.KeyMinus) || repeated(rl.KeyKpSubtract)):
		sh.nudgeZoom(-zoomStep)
	case primary && !in.Alt && (raw.IsKeyPressed(rl.KeyZero) || raw.IsKeyPressed(rl.KeyKp0)):
		sh.nudgeZoom(0)
	case mac && in.Super && !in.Alt && repeated(rl.KeyLeftBracket):
		sh.navigate(false)
	case mac && in.Super && !in.Alt && repeated(rl.KeyRightBracket):
		sh.navigate(true)
	case !mac && in.Alt && !in.Ctrl && !in.Super && repeated(rl.KeyLeft):
		sh.navigate(false)
	case !mac && in.Alt && !in.Ctrl && !in.Super && repeated(rl.KeyRight):
		sh.navigate(true)
	case !mac && in.Alt && !in.Ctrl && !in.Super && !in.Shift && raw.IsKeyPressed(rl.KeyF4):
		sh.quit.Store(true)
	}
}

// nudgeZoom changes the interface size by step percent, or puts it back to the usual one when step is 0.
func (sh *Shell) nudgeZoom(step int) {
	s := sh.settings
	next := zoomDefault
	if step != 0 {
		next = min(max(s.UIScale+step, zoomMin), zoomMax)
	}
	if next == s.UIScale {
		return
	}
	s.UIScale = next
	s.Save()
	sh.applySettings()
	redraw.Request()
}
