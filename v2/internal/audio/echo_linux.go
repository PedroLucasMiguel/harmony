//go:build cgo && linux

package audio

import (
	"encoding/hex"
	"strings"
	"time"

	"github.com/gen2brain/malgo"

	"harmony/v2/internal/echo"
)

// echoState on Linux: the sound server's echo-cancel module offers a source and a sink, and the streams open those instead of the chosen devices.
type echoState struct {
	note, source, sink string
	module             *echo.Module
}

func (d *Devices) echoOwnsIO() bool { return false }

func (d *Devices) echoReference([]int16) {}

func (d *Devices) echoClean([]int16) {}

func (d *Devices) reopenVoice() error { return nil }

func (d *Devices) dropVoice() {}

func (d *Devices) closeVoice() {}

// echoDevice is a device the echo-cancel module made, which is not for the person to choose.
func echoDevice(id string) bool { return strings.HasPrefix(serverName(id), "harmony_echo_") }

func serverName(id string) string {
	name, err := hex.DecodeString(id)
	if err != nil {
		return ""
	}
	return string(name)
}

func (d *Devices) echoStart() error {
	module, err := echo.LoadModule(serverName(d.inputID), serverName(d.outputID))
	if err != nil {
		return err
	}
	d.echo.module = module
	d.echo.source, d.echo.sink = hex.EncodeToString([]byte(module.Source)), hex.EncodeToString([]byte(module.Sink))
	for range 20 {
		if d.find(malgo.Capture, d.echo.source) != nil && d.find(malgo.Playback, d.echo.sink) != nil {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return nil
}

func (d *Devices) echoStop() {
	if d.echo.module != nil {
		d.echo.module.Close()
		d.echo.module = nil
	}
	d.echo.source, d.echo.sink = "", ""
}

// echoRetarget puts the module on the devices that were just chosen.
func (d *Devices) echoRetarget() {
	if !d.echoOn {
		return
	}
	d.closeAll()
	d.echoStop()
	if err := d.echoStart(); err != nil {
		d.echo.note = err.Error()
		d.echoOn = false
	}
	_ = d.reopenWanted()
}
