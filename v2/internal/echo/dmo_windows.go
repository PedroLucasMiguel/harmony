//go:build windows

package echo

import (
	"fmt"
	"sync"
	"syscall"
	"unsafe"
)

const (
	frame10ms      = 10
	outputQueueMax = sampleRate / 2
	refQueueMax    = sampleRate / 5
	bufferCount    = 8

	hrOK        = 0
	hrNoMore    = 1
	hrNoIFace   = 0x80004002
	incomplete  = 0x01000000
	vtBool      = 11
	vtI4        = 3
	clsctxInpro = 1
)

type guid struct {
	a uint32
	b uint16
	c uint16
	d [8]byte
}

var (
	clsidAEC          = guid{0x745057c7, 0xf353, 0x4f2d, [8]byte{0xa7, 0xee, 0x58, 0x43, 0x44, 0x77, 0x73, 0x0e}}
	iidMediaObject    = guid{0xd8ad0f58, 0x5494, 0x4102, [8]byte{0x97, 0xc5, 0xec, 0x79, 0x8e, 0x59, 0xbc, 0xf4}}
	iidPropertyStore  = guid{0x886d8eeb, 0x8cf2, 0x4446, [8]byte{0x8d, 0x02, 0xcd, 0xba, 0x1d, 0xbd, 0xcf, 0x99}}
	iidMediaBuffer    = guid{0x59eff8b9, 0x938c, 0x4a26, [8]byte{0x82, 0xf2, 0x95, 0xcb, 0x84, 0xcd, 0xc8, 0x37}}
	iidUnknown        = guid{0, 0, 0, [8]byte{0xc0, 0, 0, 0, 0, 0, 0, 0x46}}
	mediaTypeAudio    = guid{0x73647561, 0x0000, 0x0010, [8]byte{0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}}
	mediaSubtypePCM   = guid{0x00000001, 0x0000, 0x0010, [8]byte{0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}}
	formatWaveFormatX = guid{0x05589f81, 0xc356, 0x11ce, [8]byte{0xbf, 0x01, 0x00, 0xaa, 0x00, 0x55, 0x59, 0x5a}}
	aecProperties     = guid{0x6f52c567, 0x0360, 0x4bd2, [8]byte{0x96, 0x17, 0xcc, 0xbf, 0x14, 0x21, 0xc9, 0x39}}
)

// The voice capture DSP's properties (wmcodecdsp.h), all under one format id.
const (
	pidSystemMode  = 2
	pidSourceMode  = 3
	pidFeatureMode = 5
	pidNoise       = 8
	pidGain        = 9
	singleChannel  = 0
)

var (
	ole32       = syscall.NewLazyDLL("ole32.dll")
	coInit      = ole32.NewProc("CoInitializeEx")
	coCreate    = ole32.NewProc("CoCreateInstance")
	bufferTable = newBufferTable()
)

type waveFormat struct {
	tag, channels        uint16
	rate, bytesPerSec    uint32
	blockAlign, bitsEach uint16
	extra                uint16
}

type mediaType struct {
	major, subtype  guid
	fixed, temporal int32
	sampleSize      uint32
	format          guid
	unknown         uintptr
	formatSize      uint32
	formatData      *waveFormat
}

type propertyKey struct {
	format guid
	id     uint32
}

type propVariant struct {
	kind    uint16
	_, _, _ uint16
	value   int64
	_       int64
}

type outputBuffer struct {
	buffer         uintptr
	status         uint32
	time, duration int64
}

func method(object uintptr, index int) uintptr {
	vtable := *(*uintptr)(at(object))
	return *(*uintptr)(at(vtable + uintptr(index)*unsafe.Sizeof(uintptr(0))))
}

func at(p uintptr) unsafe.Pointer { return *(*unsafe.Pointer)(unsafe.Pointer(&p)) }

func call(object uintptr, index int, args ...uintptr) uintptr {
	r, _, _ := syscall.SyscallN(method(object, index), append([]uintptr{object}, args...)...)
	return r
}

func failed(hr uintptr) bool { return int32(hr) < 0 }

func hr(op string, code uintptr) error {
	if failed(code) {
		return fmt.Errorf("%s: 0x%08X", op, uint32(code))
	}
	return nil
}

// buffer is the IMediaBuffer the DSP reads and writes: a COM object made in Go.
type buffer struct {
	vtable *[6]uintptr
	data   []byte
	length uint32
}

type buffers struct {
	vtable [6]uintptr
}

func newBufferTable() *buffers {
	t := &buffers{}
	self := func(p uintptr) *buffer { return (*buffer)(at(p)) }
	t.vtable[0] = syscall.NewCallback(func(this, iid, out uintptr) uintptr {
		id := (*guid)(at(iid))
		if *id != iidMediaBuffer && *id != iidUnknown {
			*(*uintptr)(at(out)) = 0
			return hrNoIFace
		}
		*(*uintptr)(at(out)) = this
		return hrOK
	})
	t.vtable[1] = syscall.NewCallback(func(uintptr) uintptr { return 2 })
	t.vtable[2] = syscall.NewCallback(func(uintptr) uintptr { return 1 })
	t.vtable[3] = syscall.NewCallback(func(this, length uintptr) uintptr {
		b := self(this)
		if int(uint32(length)) > len(b.data) {
			return 0x80070057
		}
		b.length = uint32(length)
		return hrOK
	})
	t.vtable[4] = syscall.NewCallback(func(this, out uintptr) uintptr {
		*(*uint32)(at(out)) = uint32(len(self(this).data))
		return hrOK
	})
	t.vtable[5] = syscall.NewCallback(func(this, data, length uintptr) uintptr {
		b := self(this)
		if data != 0 {
			*(*uintptr)(at(data)) = uintptr(unsafe.Pointer(&b.data[0]))
		}
		if length != 0 {
			*(*uint32)(at(length)) = b.length
		}
		return hrOK
	})
	return t
}

func newBuffer(size int) *buffer {
	return &buffer{vtable: &bufferTable.vtable, data: make([]byte, size)}
}

func (b *buffer) com() uintptr { return uintptr(unsafe.Pointer(b)) }

// Canceller is the Voice Capture DSP, Windows' own echo canceller, run as a filter: the sound the microphone heard goes in on one input, the sound
// that was played on the other, and the microphone's sound comes out with the echo taken out. 48 kHz is asked of it first, 16 kHz when it will not.
type Canceller struct {
	mu     sync.Mutex
	object uintptr
	rate   int
	closed bool

	capture, render []*buffer
	out             *buffer
	next            int

	reference []int16
	cleaned   []int16
	chunk     []int16
}

// NewCanceller makes the DSP and sets it up.
func NewCanceller() (*Canceller, error) {
	const mta = 0
	coInit.Call(0, mta)
	var object uintptr
	if r, _, _ := coCreate.Call(uintptr(unsafe.Pointer(&clsidAEC)), 0, clsctxInpro, uintptr(unsafe.Pointer(&iidMediaObject)), uintptr(unsafe.Pointer(&object))); failed(r) {
		return nil, fmt.Errorf("the voice capture DSP is not on this system: 0x%08X", uint32(r))
	}
	c := &Canceller{object: object}
	if err := c.configure(); err != nil {
		call(object, 2)
		return nil, err
	}
	return c, nil
}

func (c *Canceller) setProperty(store uintptr, id uint32, kind uint16, value int64) uintptr {
	key := propertyKey{aecProperties, id}
	v := propVariant{kind: kind, value: value}
	return call(store, 6, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&v)))
}

func (c *Canceller) configure() error {
	var store uintptr
	if err := hr("properties", call(c.object, 0, uintptr(unsafe.Pointer(&iidPropertyStore)), uintptr(unsafe.Pointer(&store)))); err != nil {
		return err
	}
	defer call(store, 2)
	if err := hr("filter mode", c.setProperty(store, pidSourceMode, vtBool, 0)); err != nil {
		return err
	}
	if err := hr("echo mode", c.setProperty(store, pidSystemMode, vtI4, singleChannel)); err != nil {
		return err
	}
	c.setProperty(store, pidFeatureMode, vtBool, -1)
	c.setProperty(store, pidNoise, vtI4, 0)
	c.setProperty(store, pidGain, vtI4, 0)

	var last error
	for _, rate := range []int{sampleRate, 16000} {
		if last = c.setFormats(rate); last == nil {
			c.rate = rate
			break
		}
	}
	if last != nil {
		return last
	}
	size := c.rate / 100 * 2
	for range bufferCount {
		c.capture, c.render = append(c.capture, newBuffer(size)), append(c.render, newBuffer(size))
	}
	c.out = newBuffer(size * 8)
	c.chunk = make([]int16, c.rate/100)
	return hr("allocate", call(c.object, 18))
}

func (c *Canceller) setFormats(rate int) error {
	format := waveFormat{tag: 1, channels: 1, rate: uint32(rate), bytesPerSec: uint32(rate * 2), blockAlign: 2, bitsEach: 16}
	mt := mediaType{major: mediaTypeAudio, subtype: mediaSubtypePCM, fixed: 1, sampleSize: 2, format: formatWaveFormatX, formatSize: uint32(unsafe.Sizeof(format)), formatData: &format}
	for stream := range uintptr(2) {
		if err := hr("input format", call(c.object, 8, stream, uintptr(unsafe.Pointer(&mt)), 0)); err != nil {
			return err
		}
	}
	return hr("output format", call(c.object, 9, 0, uintptr(unsafe.Pointer(&mt)), 0))
}

// Reference is what was just played, stereo at 48 kHz; the DSP is told it mixed down to one channel.
func (c *Canceller) Reference(stereo []int16) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	step := sampleRate / c.rate
	for i := 0; i+2*step <= len(stereo); i += 2 * step {
		var sum int
		for j := 0; j < 2*step; j++ {
			sum += int(stereo[i+j])
		}
		c.reference = append(c.reference, int16(sum/(2*step)))
	}
	if over := len(c.reference) - refQueueMax; over > 0 {
		c.reference = append(c.reference[:0], c.reference[over:]...)
	}
}

// Clean takes the echo out of 48 kHz mono sound, in place.
func (c *Canceller) Clean(frame []int16) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	step := sampleRate / c.rate
	for start := 0; start+step*len(c.chunk) <= len(frame); start += step * len(c.chunk) {
		for i := range c.chunk {
			var sum int
			for j := 0; j < step; j++ {
				sum += int(frame[start+i*step+j])
			}
			c.chunk[i] = int16(sum / step)
		}
		c.push()
	}
	n := copy(frame, c.cleaned)
	c.cleaned = append(c.cleaned[:0], c.cleaned[n:]...)
}

// push gives the DSP one 10 ms chunk of microphone sound with the 10 ms of played sound that goes with it, and collects what it answers.
func (c *Canceller) push() {
	slot := c.next % bufferCount
	c.next++
	mic, ref := c.capture[slot], c.render[slot]
	fill(mic, c.chunk)
	n := min(len(c.chunk), len(c.reference))
	clear(c.chunk)
	copy(c.chunk, c.reference[:n])
	c.reference = append(c.reference[:0], c.reference[n:]...)
	fill(ref, c.chunk)
	call(c.object, 21, 0, mic.com(), 0, 0, 0)
	call(c.object, 21, 1, ref.com(), 0, 0, 0)
	for {
		c.out.length = 0
		data := outputBuffer{buffer: c.out.com()}
		var status uint32
		r := call(c.object, 22, 0, 1, uintptr(unsafe.Pointer(&data)), uintptr(unsafe.Pointer(&status)))
		if failed(r) || r == hrNoMore && c.out.length == 0 {
			return
		}
		samples := unsafe.Slice((*int16)(unsafe.Pointer(&c.out.data[0])), c.out.length/2)
		step := sampleRate / c.rate
		for _, s := range samples {
			for range step {
				c.cleaned = append(c.cleaned, s)
			}
		}
		if len(c.cleaned) > outputQueueMax {
			c.cleaned = c.cleaned[len(c.cleaned)-outputQueueMax:]
		}
		if data.status&incomplete == 0 {
			return
		}
	}
}

func fill(b *buffer, samples []int16) {
	copy(unsafe.Slice((*int16)(unsafe.Pointer(&b.data[0])), len(b.data)/2), samples)
	b.length = uint32(len(samples) * 2)
}

// Close releases the DSP.
func (c *Canceller) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	call(c.object, 19)
	call(c.object, 2)
}
