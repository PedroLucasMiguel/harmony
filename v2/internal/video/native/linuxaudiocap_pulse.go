//go:build linux

package native

// System audio on Linux: what the default output plays, read from its monitor source through libpulse-simple, loaded at run
// time (no cgo). PipeWire's pulse server answers the same calls. The monitor carries everything, this program's own sound
// included, so nothing can be left out and a share's sound is not offered back to its sender.

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	paSampleS16LE   = 3
	paStreamRecord  = 2
	paNoValue       = ^uint32(0)
	pulseFrameBytes = 960 * 4
)

type paSampleSpec struct {
	format   int32
	rate     uint32
	channels uint8
}

type paBufferAttr struct {
	maxLength, tLength, preBuf, minReq, fragSize uint32
}

var pulse struct {
	once sync.Once
	err  error

	simpleNew  func(server, name *byte, dir int32, dev, stream *byte, ss *paSampleSpec, cmap unsafe.Pointer, attr *paBufferAttr, err *int32) uintptr
	simpleRead func(s uintptr, data unsafe.Pointer, bytes uintptr, err *int32) int32
	simpleFree func(s uintptr)
	strerror   func(err int32) string
}

func pulseLoad() error {
	pulse.once.Do(func() {
		defer func() {
			if r := recover(); r != nil {
				pulse.err = fmt.Errorf("PulseAudio is not available: %v", r)
			}
		}()
		var lib, base uintptr
		var err error
		for _, name := range []string{"libpulse-simple.so.0", "libpulse-simple.so"} {
			if lib, err = purego.Dlopen(name, purego.RTLD_LAZY|purego.RTLD_GLOBAL); err == nil {
				break
			}
		}
		if err != nil {
			pulse.err = errors.New("System audio needs PulseAudio or PipeWire's pulse server (libpulse-simple is missing).")
			return
		}
		if base, err = purego.Dlopen("libpulse.so.0", purego.RTLD_LAZY|purego.RTLD_GLOBAL); err != nil {
			pulse.err = errors.New("System audio needs PulseAudio or PipeWire's pulse server (libpulse is missing).")
			return
		}
		purego.RegisterLibFunc(&pulse.simpleNew, lib, "pa_simple_new")
		purego.RegisterLibFunc(&pulse.simpleRead, lib, "pa_simple_read")
		purego.RegisterLibFunc(&pulse.simpleFree, lib, "pa_simple_free")
		purego.RegisterLibFunc(&pulse.strerror, base, "pa_strerror")
	})
	return pulse.err
}

func cstr(s string) *byte {
	b := append([]byte(s), 0)
	return &b[0]
}

type pulseCapture struct {
	stream uintptr
	closed atomic.Bool
	done   chan struct{}
}

func startAudioCapture(p AudioCaptureParams, onPCM func([]int16)) (AudioCapture, error) {
	if p.PID != 0 {
		return nil, errors.New("PulseAudio cannot give one application's sound alone")
	}
	if err := pulseLoad(); err != nil {
		return nil, err
	}
	ss := paSampleSpec{format: paSampleS16LE, rate: 48000, channels: 2}
	attr := paBufferAttr{maxLength: paNoValue, tLength: paNoValue, preBuf: paNoValue, minReq: paNoValue, fragSize: pulseFrameBytes}
	var code int32
	stream := pulse.simpleNew(nil, cstr("Harmony"), paStreamRecord, cstr("@DEFAULT_MONITOR@"), cstr("share audio"), &ss, nil, &attr, &code)
	if stream == 0 {
		return nil, fmt.Errorf("PulseAudio could not open the output's monitor: %s", pulse.strerror(code))
	}
	c := &pulseCapture{stream: stream, done: make(chan struct{})}
	go c.run(onPCM)
	return c, nil
}

func (c *pulseCapture) run(onPCM func([]int16)) {
	defer close(c.done)
	buf := make([]int16, pulseFrameBytes/2)
	for !c.closed.Load() {
		var code int32
		if pulse.simpleRead(c.stream, unsafe.Pointer(&buf[0]), pulseFrameBytes, &code) < 0 {
			return
		}
		if !c.closed.Load() {
			onPCM(buf)
		}
	}
}

// Close stops reading. A read waits for the server to send sound, which a suspended output does not, so the stream is only
// freed once the reader has come back; a reader that never does is left alone rather than freed under its feet.
func (c *pulseCapture) Close() {
	if c.closed.Swap(true) {
		return
	}
	select {
	case <-c.done:
		pulse.simpleFree(c.stream)
	case <-time.After(500 * time.Millisecond):
	}
}

func listAudioApps() []AudioApp { return nil }

func audioSupport() AudioSupport {
	if err := pulseLoad(); err != nil {
		return AudioSupport{Reason: err.Error()}
	}
	return AudioSupport{System: true}
}

func windowAudioPID(uint32) int { return 0 }
