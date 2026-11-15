package channels

import (
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"harmony/v2/internal/audio"
)

const devicePoll = 3 * time.Second

// deviceWatch follows the chosen microphone and speakers while in a call: one that is unplugged is swapped for the system's own until
// it is back, and the choice itself is kept so that it comes back on its own.
type deviceWatch struct {
	wantIn   atomic.Pointer[string]
	wantOut  atomic.Pointer[string]
	wanted   atomic.Bool
	running  atomic.Bool
	fellIn   bool
	fellOut  bool
	reported string
}

func present(list []audio.Device, id string) bool {
	for _, d := range list {
		if d.ID == id {
			return true
		}
	}
	return false
}

// follow keeps the watch going while joined is true; call it every frame.
func (s *Screen) followDevices(joined bool) {
	w := &s.devices
	w.wanted.Store(joined)
	if !joined || s.Devices == nil {
		return
	}
	if in := w.wantIn.Load(); in == nil || *in != s.Settings.InputDevice {
		v := s.Settings.InputDevice
		w.wantIn.Store(&v)
	}
	if out := w.wantOut.Load(); out == nil || *out != s.Settings.OutputDevice {
		v := s.Settings.OutputDevice
		w.wantOut.Store(&v)
	}
	if w.running.CompareAndSwap(false, true) {
		go s.runDeviceWatch()
	}
}

func (s *Screen) runDeviceWatch() {
	w := &s.devices
	defer w.running.Store(false)
	ticker := time.NewTicker(devicePoll)
	defer ticker.Stop()
	for w.wanted.Load() {
		select {
		case <-s.Session.Done():
			return
		case <-ticker.C:
		}
		var missing []string
		in, out := *w.wantIn.Load(), *w.wantOut.Load()
		if in != "" && !present(s.Devices.Inputs(), in) {
			missing = append(missing, "devices.microphone")
			if !w.fellIn {
				w.fellIn = true
				_ = s.Devices.SetInput("")
			}
		} else if w.fellIn {
			w.fellIn = false
			_ = s.Devices.SetInput(in)
		}
		if out != "" && !present(s.Devices.Outputs(), out) {
			missing = append(missing, "devices.output")
			if !w.fellOut {
				w.fellOut = true
				_ = s.Devices.SetOutput("")
			}
		} else if w.fellOut {
			w.fellOut = false
			_ = s.Devices.SetOutput(out)
		}
		s.reportMissing(missing)
	}
}

// reportMissing says which chosen devices are unplugged, once for each change.
func (s *Screen) reportMissing(keys []string) {
	w := &s.devices
	names := strings.Join(keys, ",")
	if names == w.reported {
		return
	}
	w.reported = names
	bundle := s.room.strings
	if len(keys) == 0 || bundle == nil {
		return
	}
	what := make([]string, len(keys))
	for i, k := range keys {
		what[i] = bundle.T(k)
	}
	s.say(bundle.T("devices.unplugged", "count", strconv.Itoa(len(keys)), "what", strings.Join(what, " & ")))
}
