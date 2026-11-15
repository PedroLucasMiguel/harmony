package shell

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/platform"
)

// openWindow creates the window. The interface is flat 2D, so the window gets no depth or stencil buffer.
func openWindow(width, height int) {
	platform.NoDepthBuffer()
	rl.SetConfigFlags(rl.FlagWindowResizable | rl.FlagWindowHighdpi | rl.FlagVsyncHint | openFlags())
	rl.SetTraceLogLevel(rl.LogWarning)
	rl.InitWindow(int32(width), int32(height), title)
}
