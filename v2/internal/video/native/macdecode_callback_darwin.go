//go:build darwin

package native

import "github.com/ebitengine/purego"

// mdecNewCallback makes the one function VideoToolbox calls with decoded pictures; the decoder is found by the refcon.
// Callbacks are never freed, so there is one for the process.
func mdecNewCallback() uintptr {
	return purego.NewCallback(func(refcon, _, status, _, image uintptr) uintptr {
		if d, ok := mdecDecoders.Load(refcon); ok {
			d.(*macDecoder).picture(int32(status), image)
		}
		return 0
	})
}
