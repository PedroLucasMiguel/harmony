// harmony2 is the Go and raylib client for a Harmony server.
package main

import (
	"flag"
	"runtime"
	"runtime/debug"

	"harmony/v2/internal/shell"
)

const gcPercent = 40

func main() {
	runtime.LockOSThread()
	// The live heap is small and a frame allocates almost nothing, so the heap may grow only a little between collections.
	debug.SetGCPercent(gcPercent)
	var options shell.Options
	flag.StringVar(&options.Server, "server", "", "server address to start with")
	flag.IntVar(&options.Width, "width", 0, "window width in logical pixels")
	flag.IntVar(&options.Height, "height", 0, "window height in logical pixels")
	flag.Float64Var(&options.Tone, "tone", 0, "send a tone of this many Hz as the microphone")
	flag.StringVar(&options.Screenshot, "screenshot", "", "write the window to this PNG and exit")
	flag.Parse()
	shell.Run(options)
}
