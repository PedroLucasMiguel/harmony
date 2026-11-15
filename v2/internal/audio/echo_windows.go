//go:build cgo && windows

package audio

import (
	"sync/atomic"

	"harmony/v2/internal/echo"
)

// echoState on Windows: the Voice Capture DSP sits between the streams. Everything the speakers are given goes to it as the reference, and every
// microphone frame goes through it before the chain.
type echoState struct {
	note, source, sink string
	canceller          atomic.Pointer[echo.Canceller]
}

func (d *Devices) echoOwnsIO() bool { return false }

func (d *Devices) echoStart() error {
	canceller, err := echo.NewCanceller()
	if err != nil {
		return err
	}
	d.echo.canceller.Store(canceller)
	return nil
}

func (d *Devices) echoStop() {
	if canceller := d.echo.canceller.Swap(nil); canceller != nil {
		canceller.Close()
	}
}

func (d *Devices) echoRetarget() {}

func (d *Devices) echoReference(pcm []int16) {
	if c := d.echo.canceller.Load(); c != nil {
		c.Reference(pcm)
	}
}

func (d *Devices) echoClean(frame []int16) {
	if c := d.echo.canceller.Load(); c != nil {
		c.Clean(frame)
	}
}

func (d *Devices) reopenVoice() error { return nil }

func (d *Devices) dropVoice() {}

func (d *Devices) closeVoice() {}

func echoDevice(string) bool { return false }
