//go:build cgo && darwin

package audio

import (
	"sync/atomic"

	"harmony/v2/internal/echo"
)

// echoState on a Mac: with cancellation on, Apple's voice processing unit plays and records instead of the two miniaudio streams, so the system hears
// what is played and takes it out of what is recorded.
type echoState struct {
	note, source, sink string

	unit          *echo.Unit
	input, output string
	mixer         atomic.Pointer[Mixer]
	record        atomic.Pointer[func(frame []int16)]
}

func (d *Devices) echoOwnsIO() bool { return d.echoOn }

func (d *Devices) echoStart() error { return nil }

func (d *Devices) echoStop() {}

func (d *Devices) echoRetarget() {}

func (d *Devices) echoReference([]int16) {}

func (d *Devices) echoClean([]int16) {}

func (d *Devices) syncVoice() {
	var mixer *Mixer
	if d.speakersWanted {
		mixer = d.mixer
	}
	d.echo.mixer.Store(mixer)
	var record *func(frame []int16)
	if d.micWanted {
		record = &d.onFrame
	}
	d.echo.record.Store(record)
}

// reopenVoice makes the unit match what is wanted: open for what is in use, on the chosen devices, closed when nothing is.
func (d *Devices) reopenVoice() error {
	e := &d.echo
	d.syncVoice()
	if !d.speakersWanted && !d.micWanted {
		d.dropVoice()
		return nil
	}
	if e.unit != nil && e.input == d.inputID && e.output == d.outputID {
		return nil
	}
	d.dropUnit()
	cfg := echo.Config{
		Input: d.inputID, Output: d.outputID,
		Play: func(out []int16) {
			if m := e.mixer.Load(); m != nil {
				m.Mix(out)
				return
			}
			clear(out)
		},
		Record: func(frame []int16) {
			if f := e.record.Load(); f != nil {
				(*f)(frame)
			}
		},
	}
	unit, err := echo.Open(cfg)
	if err != nil && (cfg.Input != "" || cfg.Output != "") {
		cfg.Input, cfg.Output = "", ""
		unit, _ = echo.Open(cfg)
	}
	if unit == nil {
		e.note = err.Error()
		return err
	}
	e.unit, e.input, e.output = unit, d.inputID, d.outputID
	return err
}

func (d *Devices) closeVoice() { d.dropUnit() }

func (d *Devices) dropUnit() {
	if d.echo.unit != nil {
		d.echo.unit.Close()
		d.echo.unit = nil
	}
}

// dropVoice is called when a stream stops: the unit stays while the other one is in use.
func (d *Devices) dropVoice() {
	d.syncVoice()
	if !d.speakersWanted && !d.micWanted {
		d.dropUnit()
	}
}

func echoDevice(string) bool { return false }
