package shell

import (
	"runtime"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/assets"
	"harmony/v2/internal/platform"
)

// openWindow creates the window. The interface is flat 2D, so the window gets no depth or stencil buffer.
func openWindow(width, height int) {
	platform.NoDepthBuffer()
	rl.SetConfigFlags(rl.FlagWindowResizable | rl.FlagWindowHighdpi | rl.FlagVsyncHint | openFlags())
	rl.SetTraceLogLevel(rl.LogWarning)
	rl.InitWindow(int32(width), int32(height), title)
	setIcon()
}

// setIcon gives the window its icon where the window system takes one from the program: Windows reads it from the
// executable's resources (cmd/harmony2/rsrc_windows_*.syso) and macOS from the application's bundle.
func setIcon() {
	if runtime.GOOS != "linux" {
		return
	}
	data, err := assets.FS.ReadFile("logo.png")
	if err != nil {
		return
	}
	img := rl.LoadImageFromMemory(".png", data, int32(len(data)))
	rl.SetWindowIcon(*img)
	rl.UnloadImage(img)
}
