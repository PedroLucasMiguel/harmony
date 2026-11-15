package shell

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/app"
	"harmony/v2/internal/desktop"
	"harmony/v2/internal/platform"
	"harmony/v2/internal/ui/raw"
	"harmony/v2/internal/ui/redraw"
)

// startDesktop brings up the hotkeys, the tray icon and the rest of what lives outside the window.
func (sh *Shell) startDesktop() {
	sh.desktop = desktop.New(desktop.Options{
		Settings: sh.settings,
		Window: desktop.Window{
			Show:    func() { sh.context.Post(showWindow) },
			Hide:    func() { sh.context.Post(hideWindow) },
			Focused: sh.focused.Load,
			Quit:    func() { sh.quit.Store(true); redraw.Request() },
		},
		Strings: sh.strings,
		Post:    sh.context.Post,
		Redraw:  redraw.Request,
		Open: func(n app.Notice) {
			if sh.channels != nil {
				sh.channels.OpenNotice(sh.context, n)
			}
		},
		ToggleCamera: sh.toggleCamera,
		Away:         sh.idleAway,
	})
}

// closing says whether the program should end. The close button only hides the window while the tray can bring it back; raylib reports a close request for one frame, so seeing it once is enough.
func (sh *Shell) closing() bool {
	if sh.quit.Load() {
		return true
	}
	if !raw.WindowShouldClose() {
		return false
	}
	if sh.desktop.HideOnClose() && !platform.QuitKey() {
		sh.desktop.HideWindow()
		return false
	}
	return true
}

func showWindow() {
	rl.ClearWindowState(rl.FlagWindowHidden)
	rl.RestoreWindow()
	rl.SetWindowFocused()
	platform.Activate()
	redraw.Request()
}

func hideWindow() { rl.SetWindowState(rl.FlagWindowHidden) }

func (sh *Shell) toggleCamera() {
	session := sh.session
	if session == nil || !session.InVoice() {
		return
	}
	if session.State().Camera {
		session.StopCamera()
		return
	}
	go func() { _ = sh.startCamera(session) }()
}
