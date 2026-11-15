//go:build linux

package echo

import (
	"errors"
	"strconv"
	"sync"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	contextReady  = 4
	invalidIndex  = 0xFFFFFFFF
	waitForServer = 3 * time.Second
)

// Module is PulseAudio's (or PipeWire's) module-echo-cancel, loaded through libpulse: the sound server then offers a source with the echo taken out
// and a sink whose sound is the reference. Source and Sink are the names to open the devices with.
type Module struct {
	Source, Sink string

	loop, ctx uintptr
	index     uint32
	keep      [][]byte
}

var pulse struct {
	once sync.Once
	err  error

	mainloopNew, mainloopFree, mainloopStart, mainloopStop, mainloopLock, mainloopUnlock, getAPI uintptr
	contextNew, contextUnref, setState, connect, disconnect, getState, loadModule, unloadModule  uintptr
	opUnref                                                                                      uintptr

	state  chan struct{}
	loaded chan uint32
}

func loadPulse() error {
	pulse.once.Do(func() {
		lib, err := purego.Dlopen("libpulse.so.0", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			pulse.err = errors.New("libpulse is not installed")
			return
		}
		sym := func(name string) uintptr {
			p, err := purego.Dlsym(lib, name)
			if err != nil && pulse.err == nil {
				pulse.err = err
			}
			return p
		}
		pulse.mainloopNew, pulse.mainloopFree = sym("pa_threaded_mainloop_new"), sym("pa_threaded_mainloop_free")
		pulse.mainloopStart, pulse.mainloopStop = sym("pa_threaded_mainloop_start"), sym("pa_threaded_mainloop_stop")
		pulse.mainloopLock, pulse.mainloopUnlock = sym("pa_threaded_mainloop_lock"), sym("pa_threaded_mainloop_unlock")
		pulse.getAPI = sym("pa_threaded_mainloop_get_api")
		pulse.contextNew, pulse.contextUnref = sym("pa_context_new"), sym("pa_context_unref")
		pulse.setState, pulse.connect = sym("pa_context_set_state_callback"), sym("pa_context_connect")
		pulse.disconnect, pulse.getState = sym("pa_context_disconnect"), sym("pa_context_get_state")
		pulse.loadModule, pulse.unloadModule = sym("pa_context_load_module"), sym("pa_context_unload_module")
		pulse.opUnref = sym("pa_operation_unref")
		pulse.state, pulse.loaded = make(chan struct{}, 4), make(chan uint32, 1)
	})
	return pulse.err
}

var (
	stateCallback  uintptr
	loadedCallback uintptr
	callbackOnce   sync.Once
)

func callbacks() (uintptr, uintptr) {
	callbackOnce.Do(func() {
		stateCallback = purego.NewCallback(func(_, _ uintptr) uintptr {
			select {
			case pulse.state <- struct{}{}:
			default:
			}
			return 0
		})
		loadedCallback = purego.NewCallback(func(_, index, _ uintptr) uintptr {
			select {
			case pulse.loaded <- uint32(index):
			default:
			}
			return 0
		})
	})
	return stateCallback, loadedCallback
}

// cstr is a C string that lives as long as the module.
func (m *Module) cstr(s string) uintptr {
	b := append([]byte(s), 0)
	m.keep = append(m.keep, b)
	return uintptr(unsafe.Pointer(&b[0]))
}

func sys(fn uintptr, args ...uintptr) uintptr {
	r, _, _ := purego.SyscallN(fn, args...)
	return r
}

// LoadModule connects to the sound server and loads the module on top of the given source and sink (empty for the server's defaults).
func LoadModule(sourceMaster, sinkMaster string) (*Module, error) {
	if err := loadPulse(); err != nil {
		return nil, err
	}
	state, _ := callbacks()
	m := &Module{Source: "harmony_echo_source", Sink: "harmony_echo_sink"}
	if m.loop = sys(pulse.mainloopNew); m.loop == 0 {
		return nil, errors.New("the sound server could not be reached")
	}
	api := sys(pulse.getAPI, m.loop)
	m.ctx = sys(pulse.contextNew, api, m.cstr("Harmony"))
	sys(pulse.mainloopLock, m.loop)
	sys(pulse.setState, m.ctx, state, 0)
	sys(pulse.connect, m.ctx, 0, 0, 0)
	sys(pulse.mainloopUnlock, m.loop)
	sys(pulse.mainloopStart, m.loop)

	drain(pulse.state)
	if err := m.waitReady(); err != nil {
		m.Close()
		return nil, err
	}
	args := "source_name=" + m.Source + " sink_name=" + m.Sink + " aec_method=webrtc"
	if sourceMaster != "" {
		args += " source_master=" + sourceMaster
	}
	if sinkMaster != "" {
		args += " sink_master=" + sinkMaster
	}
	for _, extra := range []string{` aec_args="analog_gain_control=0 digital_gain_control=0"`, ""} {
		if m.index = m.load(args + extra); m.index != invalidIndex {
			return m, nil
		}
	}
	m.Close()
	return nil, errors.New("the sound server has no module-echo-cancel (install it with PulseAudio, or use PipeWire's pulse server)")
}

func drain[T any](c chan T) {
	for {
		select {
		case <-c:
		default:
			return
		}
	}
}

func (m *Module) waitReady() error {
	deadline := time.After(waitForServer)
	for {
		sys(pulse.mainloopLock, m.loop)
		state := int32(sys(pulse.getState, m.ctx))
		sys(pulse.mainloopUnlock, m.loop)
		switch {
		case state == contextReady:
			return nil
		case state >= 5:
			return errors.New("the sound server did not answer (state " + strconv.Itoa(int(state)) + ")")
		}
		select {
		case <-pulse.state:
		case <-deadline:
			return errors.New("the sound server did not answer in time")
		}
	}
}

func (m *Module) load(args string) uint32 {
	_, loaded := callbacks()
	drain(pulse.loaded)
	sys(pulse.mainloopLock, m.loop)
	op := sys(pulse.loadModule, m.ctx, m.cstr("module-echo-cancel"), m.cstr(args), loaded, 0)
	if op != 0 {
		sys(pulse.opUnref, op)
	}
	sys(pulse.mainloopUnlock, m.loop)
	select {
	case index := <-pulse.loaded:
		return index
	case <-time.After(waitForServer):
		return invalidIndex
	}
}

// Close unloads the module and disconnects.
func (m *Module) Close() {
	if m == nil || m.loop == 0 {
		return
	}
	if m.index != 0 && m.index != invalidIndex {
		sys(pulse.mainloopLock, m.loop)
		if op := sys(pulse.unloadModule, m.ctx, uintptr(m.index), 0, 0); op != 0 {
			sys(pulse.opUnref, op)
		}
		sys(pulse.mainloopUnlock, m.loop)
		time.Sleep(50 * time.Millisecond)
	}
	sys(pulse.mainloopLock, m.loop)
	sys(pulse.disconnect, m.ctx)
	sys(pulse.contextUnref, m.ctx)
	sys(pulse.mainloopUnlock, m.loop)
	sys(pulse.mainloopStop, m.loop)
	sys(pulse.mainloopFree, m.loop)
	m.loop = 0
}
