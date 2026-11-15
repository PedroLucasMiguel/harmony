//go:build darwin

// Apple's voice processing audio unit, called through AudioToolbox without cgo.

package echo

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	audioToolbox = "/System/Library/Frameworks/AudioToolbox.framework/AudioToolbox"
	coreAudio    = "/System/Library/Frameworks/CoreAudio.framework/CoreAudio"
	coreFound    = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"

	frameSize = sampleRate / 50

	fourVoiceIO = 0x7670696F // 'vpio'
	fourOutput  = 0x61756F75 // 'auou'
	fourApple   = 0x6170706C // 'appl'
	fourLPCM    = 0x6C70636D // 'lpcm'

	propEnableIO       = 2003
	propStreamFormat   = 8
	propRenderCallback = 23
	propInputCallback  = 2005
	propCurrentDevice  = 2000
	propBypass         = 2100
	propAGC            = 2101
	propDucking        = 2108

	scopeGlobal, scopeInput, scopeOutput = 0, 1, 2
	busOutput, busInput                  = 0, 1

	formatSigned16 = 4 | 8
	duckingMin     = 10
	cfUTF8         = 0x08000100
	uidToDevice    = 0x75696464 // 'uidd'
	audioGlobal    = 0x676C6F62 // 'glob'
)

type streamFormat struct {
	rate                                 float64
	id, flags, bytesPacket, framesPacket uint32
	bytesFrame, channels, bits, reserved uint32
}

type audioBuffer struct {
	channels, size uint32
	data           uintptr
}

type bufferList struct {
	count  uint32
	_      uint32
	buffer audioBuffer
}

type componentDescription struct{ kind, sub, maker, flags, mask uint32 }

type callbackStruct struct{ proc, refcon uintptr }

type propertyAddress struct{ selector, scope, element uint32 }

var api struct {
	once sync.Once
	err  error

	findNext, instanceNew, dispose, setProperty, getProperty, initialize, uninitialize, start, stop, render uintptr
	getData, createString, release                                                                          uintptr

	renderProc, inputProc uintptr
}

// loadAPI opens the frameworks once and makes the two callbacks the unit calls: both reach the unit that is open, of which there is one at a time.
func loadAPI() error {
	api.once.Do(func() {
		tb, err := purego.Dlopen(audioToolbox, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			api.err = err
			return
		}
		ca, err := purego.Dlopen(coreAudio, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			api.err = err
			return
		}
		cf, err := purego.Dlopen(coreFound, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			api.err = err
			return
		}
		sym := func(lib uintptr, name string) uintptr {
			p, err := purego.Dlsym(lib, name)
			if err != nil && api.err == nil {
				api.err = err
			}
			return p
		}
		api.findNext, api.instanceNew, api.dispose = sym(tb, "AudioComponentFindNext"), sym(tb, "AudioComponentInstanceNew"), sym(tb, "AudioComponentInstanceDispose")
		api.setProperty, api.getProperty = sym(tb, "AudioUnitSetProperty"), sym(tb, "AudioUnitGetProperty")
		api.initialize, api.uninitialize = sym(tb, "AudioUnitInitialize"), sym(tb, "AudioUnitUninitialize")
		api.start, api.stop, api.render = sym(tb, "AudioOutputUnitStart"), sym(tb, "AudioOutputUnitStop"), sym(tb, "AudioUnitRender")
		api.getData = sym(ca, "AudioObjectGetPropertyData")
		api.createString, api.release = sym(cf, "CFStringCreateWithCString"), sym(cf, "CFRelease")
		api.renderProc = purego.NewCallback(func(_, _, _, _, frames, data uintptr) uintptr { return current.Load().play(frames, data) })
		api.inputProc = purego.NewCallback(func(_, flags, stamp, _, frames, _ uintptr) uintptr {
			return current.Load().record(flags, stamp, frames)
		})
	})
	return api.err
}

var current atomic.Pointer[Unit]

func call(fn uintptr, args ...uintptr) int32 {
	r, _, _ := purego.SyscallN(fn, args...)
	return int32(r)
}

// at is the memory a C callback was handed the address of.
func at(p uintptr) unsafe.Pointer { return *(*unsafe.Pointer)(unsafe.Pointer(&p)) }

func ptr[T any](p *T) uintptr { return uintptr(unsafe.Pointer(p)) }

// Config is what the unit plays and who hears what it records. Input and Output are device ids as the sound card lists them (the device's UID), empty
// for the system's own choice. Play is asked for interleaved stereo 48 kHz, Record is given 20 ms of mono 48 kHz sound at a time.
type Config struct {
	Input, Output string
	Play          func(out []int16)
	Record        func(frame []int16)
}

// Unit is Apple's voice processing audio unit: it records the microphone with the echo of what it plays taken out, and plays what Play fills in.
type Unit struct {
	au      uintptr
	cfg     Config
	closed  atomic.Bool
	list    bufferList
	scratch []int16
	pending [frameSize]int16
	held    int
}

// Open starts the unit. The sound it plays is the reference the microphone is cleaned with, so everything the program plays must come through Play.
func Open(cfg Config) (*Unit, error) {
	if err := loadAPI(); err != nil {
		return nil, err
	}
	u := &Unit{cfg: cfg, scratch: make([]int16, 4096)}
	if current.Load() != nil {
		return nil, errors.New("the voice unit is already open")
	}
	desc := componentDescription{kind: fourOutput, sub: fourVoiceIO, maker: fourApple}
	component, _, _ := purego.SyscallN(api.findNext, 0, ptr(&desc))
	if component == 0 {
		return nil, errors.New("this system has no voice processing")
	}
	if st := call(api.instanceNew, component, ptr(&u.au)); st != 0 {
		return nil, fmt.Errorf("voice unit: %d", st)
	}
	if err := u.configure(); err != nil {
		u.dispose()
		return nil, err
	}
	current.Store(u)
	if st := call(api.start, u.au); st != 0 {
		current.Store(nil)
		u.dispose()
		return nil, fmt.Errorf("voice unit start: %d", st)
	}
	return u, nil
}

func (u *Unit) set(prop, scope, element uint32, data unsafe.Pointer, size uintptr) int32 {
	return call(api.setProperty, u.au, uintptr(prop), uintptr(scope), uintptr(element), uintptr(data), size)
}

func (u *Unit) configure() error {
	on := uint32(1)
	if st := u.set(propEnableIO, scopeInput, busInput, unsafe.Pointer(&on), 4); st != 0 {
		return fmt.Errorf("voice unit input: %d", st)
	}
	if st := u.set(propEnableIO, scopeOutput, busOutput, unsafe.Pointer(&on), 4); st != 0 {
		return fmt.Errorf("voice unit output: %d", st)
	}
	if device := chosenDevice(u.cfg.Input, u.cfg.Output); device != 0 {
		u.set(propCurrentDevice, scopeGlobal, 0, unsafe.Pointer(&device), 4)
	}
	mono := streamFormat{rate: sampleRate, id: fourLPCM, flags: formatSigned16, bytesPacket: 2, framesPacket: 1, bytesFrame: 2, channels: 1, bits: 16}
	if st := u.set(propStreamFormat, scopeOutput, busInput, unsafe.Pointer(&mono), unsafe.Sizeof(mono)); st != 0 {
		return fmt.Errorf("voice unit microphone format: %d", st)
	}
	stereo := streamFormat{rate: sampleRate, id: fourLPCM, flags: formatSigned16, bytesPacket: 4, framesPacket: 1, bytesFrame: 4, channels: 2, bits: 16}
	if st := u.set(propStreamFormat, scopeInput, busOutput, unsafe.Pointer(&stereo), unsafe.Sizeof(stereo)); st != 0 {
		return fmt.Errorf("voice unit speaker format: %d", st)
	}
	off := uint32(0)
	u.set(propAGC, scopeGlobal, 0, unsafe.Pointer(&off), 4)
	ducking := struct{ advanced, level uint32 }{0, duckingMin}
	u.set(propDucking, scopeGlobal, 0, unsafe.Pointer(&ducking), unsafe.Sizeof(ducking))

	play := callbackStruct{proc: api.renderProc}
	if st := u.set(propRenderCallback, scopeInput, busOutput, unsafe.Pointer(&play), unsafe.Sizeof(play)); st != 0 {
		return fmt.Errorf("voice unit speaker callback: %d", st)
	}
	record := callbackStruct{proc: api.inputProc}
	if st := u.set(propInputCallback, scopeGlobal, 0, unsafe.Pointer(&record), unsafe.Sizeof(record)); st != 0 {
		return fmt.Errorf("voice unit microphone callback: %d", st)
	}
	if st := call(api.initialize, u.au); st != 0 {
		return fmt.Errorf("voice unit initialize: %d", st)
	}
	return nil
}

// Bypass turns the voice processing off or on while the unit stays open; it exists to measure what the processing does.
func (u *Unit) Bypass(on bool) {
	v := uint32(0)
	if on {
		v = 1
	}
	u.set(propBypass, scopeGlobal, 0, unsafe.Pointer(&v), 4)
}

func (u *Unit) play(frames, data uintptr) uintptr {
	if u == nil || u.closed.Load() || data == 0 {
		return 0
	}
	list := (*bufferList)(at(data))
	out := unsafe.Slice((*int16)(at(list.buffer.data)), int(frames)*2)
	if u.cfg.Play == nil {
		clear(out)
		return 0
	}
	u.cfg.Play(out)
	return 0
}

func (u *Unit) record(flags, stamp, frames uintptr) uintptr {
	if u == nil || u.closed.Load() {
		return 0
	}
	if int(frames) > len(u.scratch) {
		return 0
	}
	u.list = bufferList{count: 1, buffer: audioBuffer{channels: 1, size: uint32(frames) * 2, data: ptr(&u.scratch[0])}}
	if st := call(api.render, u.au, flags, stamp, busInput, frames, ptr(&u.list)); st != 0 {
		return uintptr(st)
	}
	if u.cfg.Record == nil {
		return 0
	}
	in := u.scratch[:int(u.list.buffer.size)/2]
	for len(in) > 0 {
		c := copy(u.pending[u.held:u.held+min(len(in), frameSize-u.held)], in)
		u.held += c
		in = in[c:]
		if u.held >= frameSize {
			u.cfg.Record(u.pending[:frameSize])
			u.held = 0
		}
	}
	return 0
}

func (u *Unit) dispose() {
	call(api.uninitialize, u.au)
	call(api.dispose, u.au)
	u.au = 0
}

// Close stops the unit; no callback is running once it returns.
func (u *Unit) Close() {
	if u == nil || u.au == 0 {
		return
	}
	u.closed.Store(true)
	call(api.stop, u.au)
	current.CompareAndSwap(u, nil)
	u.dispose()
}

// chosenDevice is the sound card the unit should use, the microphone's when one is chosen and the speakers' otherwise; the voice unit works on a
// single device for both directions, so the system's own pairing of the two is what it can honour.
func chosenDevice(input, output string) uint32 {
	for _, uid := range []string{input, output} {
		if uid == "" {
			continue
		}
		if id := translateUID(uid); id != 0 {
			return id
		}
	}
	return 0
}

func translateUID(uid string) uint32 {
	b := append([]byte(uid), 0)
	str, _, _ := purego.SyscallN(api.createString, 0, ptr(&b[0]), cfUTF8)
	if str == 0 {
		return 0
	}
	defer call(api.release, str)
	const system = 1
	addr := propertyAddress{uidToDevice, audioGlobal, 0}
	var id uint32
	size := uint32(4)
	if st := call(api.getData, system, ptr(&addr), 8, ptr(&str), ptr(&size), ptr(&id)); st != 0 {
		return 0
	}
	return id
}
