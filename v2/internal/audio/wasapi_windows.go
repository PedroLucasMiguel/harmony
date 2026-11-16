//go:build windows

// The sound card on Windows through WASAPI, called without cgo: shared mode, event driven, 48 kHz 16 bit PCM in the format the
// mixer and the microphone chain use (the system converts to and from the device's own). Each open stream is a goroutine that
// stays on its own COM thread and starts over by itself when its device is unplugged or the default one changes.
package audio

import (
	"errors"
	"fmt"
	"runtime"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

const (
	clsctxAll             = 23
	audclntAutoConvertPCM = 0x80000000
	audclntSRCQuality     = 0x08000000
	audclntEventCallback  = 0x00040000
	audclntBufferSilent   = 0x2
	waveFormatPCM         = 1
	bufferHNS             = 400000 // 40 ms
	wakeEvery             = 200
	deviceActive          = 1
	eRender               = 0
	eCapture              = 1
	vtLPWSTR              = 31
	retryAfter            = time.Second
	openTimeout           = 5 * time.Second
)

type guid struct {
	d1 uint32
	d2 uint16
	d3 uint16
	d4 [8]byte
}

var (
	clsidMMDeviceEnumerator = guid{0xbcde0395, 0xe52f, 0x467c, [8]byte{0x8e, 0x3d, 0xc4, 0x57, 0x92, 0x91, 0x69, 0x2e}}
	iidIMMDeviceEnumerator  = guid{0xa95664d2, 0x9614, 0x4f35, [8]byte{0xa7, 0x46, 0xde, 0x8d, 0xb6, 0x36, 0x17, 0xe6}}
	iidIAudioClient         = guid{0x1cb9ad4c, 0xdbfa, 0x4c32, [8]byte{0xb1, 0x78, 0xc2, 0xf5, 0x68, 0xa7, 0x03, 0xb2}}
	iidIAudioRenderClient   = guid{0xf294acfc, 0x3146, 0x4483, [8]byte{0xa7, 0xbf, 0xad, 0xdc, 0xa7, 0xc2, 0x60, 0xe2}}
	iidIAudioCaptureClient  = guid{0xc8adbd64, 0xe71e, 0x48a0, [8]byte{0xa4, 0xde, 0x18, 0x5c, 0x39, 0x5c, 0xd3, 0x17}}
	keyFriendlyName         = propertyKey{guid{0xa45c254e, 0xdf1c, 0x4efd, [8]byte{0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}}, 14}

	dllOle32    = syscall.NewLazyDLL("ole32.dll")
	dllKernel32 = syscall.NewLazyDLL("kernel32.dll")
	dllAvrt     = syscall.NewLazyDLL("avrt.dll")

	procCoInitializeEx      = dllOle32.NewProc("CoInitializeEx")
	procCoUninitialize      = dllOle32.NewProc("CoUninitialize")
	procCoCreateInstance    = dllOle32.NewProc("CoCreateInstance")
	procCoTaskMemFree       = dllOle32.NewProc("CoTaskMemFree")
	procPropVariantClear    = dllOle32.NewProc("PropVariantClear")
	procCreateEventW        = dllKernel32.NewProc("CreateEventW")
	procSetEvent            = dllKernel32.NewProc("SetEvent")
	procWaitForSingleObject = dllKernel32.NewProc("WaitForSingleObject")
	procCloseHandle         = dllKernel32.NewProc("CloseHandle")
	procAvSetMmThreadChars  = dllAvrt.NewProc("AvSetMmThreadCharacteristicsW")
)

type propertyKey struct {
	id  guid
	pid uint32
}

type propVariant struct {
	vt    uint16
	_     [6]byte
	value uintptr
	_     uintptr
}

type waveFormatEx struct {
	tag            uint16
	channels       uint16
	samplesPerSec  uint32
	avgBytesPerSec uint32
	blockAlign     uint16
	bitsPerSample  uint16
	cbSize         uint16
}

type hresult int32

func (h hresult) Error() string { return fmt.Sprintf("WASAPI error 0x%08X", uint32(h)) }

func check(op string, h hresult) error {
	if h >= 0 {
		return nil
	}
	return fmt.Errorf("%s: %w", op, h)
}

func at(addr uintptr) unsafe.Pointer { return *(*unsafe.Pointer)(unsafe.Pointer(&addr)) }

// com is a pointer to a COM interface; slot numbers count IUnknown's three methods first.
type com uintptr

//go:uintptrescapes
func (c com) call(slot int, args ...uintptr) hresult {
	var a [10]uintptr
	a[0] = uintptr(c)
	n := copy(a[1:], args)
	fn := *(*uintptr)(at(*(*uintptr)(at(uintptr(c))) + uintptr(slot)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(fn, a[:n+1]...)
	return hresult(int32(r))
}

func (c com) release() {
	if c != 0 {
		c.call(2)
	}
}

//go:uintptrescapes
func callProc(p *syscall.LazyProc, args ...uintptr) hresult {
	if err := p.Find(); err != nil {
		return hresult(-2147024770)
	}
	r, _, _ := syscall.SyscallN(p.Addr(), args...)
	return hresult(int32(r))
}

// onCOMThread runs fn on a thread of its own that has joined the multithreaded apartment.
func onCOMThread(fn func()) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		if hr := callProc(procCoInitializeEx, 0, 0); hr >= 0 {
			defer callProc(procCoUninitialize)
		}
		fn()
	}()
	<-done
}

func newEnumerator() (com, error) {
	var out uintptr
	if hr := callProc(procCoCreateInstance, uintptr(unsafe.Pointer(&clsidMMDeviceEnumerator)), 0, clsctxAll,
		uintptr(unsafe.Pointer(&iidIMMDeviceEnumerator)), uintptr(unsafe.Pointer(&out))); hr < 0 {
		return 0, check("CoCreateInstance(MMDeviceEnumerator)", hr)
	}
	return com(out), nil
}

// endpoint is the device with that id, or the default one of its kind for an empty id.
func endpoint(enum com, flow int, id string) (com, error) {
	var dev uintptr
	if id == "" {
		return com(dev), check("GetDefaultAudioEndpoint (is there a sound device?)", enum.call(4, uintptr(flow), 0, uintptr(unsafe.Pointer(&dev))))
	}
	wide, err := syscall.UTF16PtrFromString(id)
	if err != nil {
		return 0, err
	}
	return com(dev), check("GetDevice", enum.call(5, uintptr(unsafe.Pointer(wide)), uintptr(unsafe.Pointer(&dev))))
}

func deviceID(dev com) string {
	var p uintptr
	if dev.call(5, uintptr(unsafe.Pointer(&p))) < 0 {
		return ""
	}
	defer callProc(procCoTaskMemFree, p)
	return utf16At(p)
}

func deviceName(dev com) string {
	var store uintptr
	if dev.call(4, 0, uintptr(unsafe.Pointer(&store))) < 0 { // OpenPropertyStore(STGM_READ)
		return ""
	}
	defer com(store).release()
	var v propVariant
	if com(store).call(5, uintptr(unsafe.Pointer(&keyFriendlyName)), uintptr(unsafe.Pointer(&v))) < 0 {
		return ""
	}
	defer callProc(procPropVariantClear, uintptr(unsafe.Pointer(&v)))
	if v.vt != vtLPWSTR {
		return ""
	}
	return utf16At(v.value)
}

func utf16At(p uintptr) string {
	if p == 0 {
		return ""
	}
	n := 0
	for *(*uint16)(at(p + uintptr(n)*2)) != 0 {
		n++
	}
	return syscall.UTF16ToString(unsafe.Slice((*uint16)(at(p)), n))
}

// listEndpoints is every plugged in device of one kind.
func listEndpoints(flow int) []Device {
	var list []Device
	onCOMThread(func() {
		enum, err := newEnumerator()
		if err != nil {
			return
		}
		defer enum.release()
		var coll uintptr
		if enum.call(3, uintptr(flow), deviceActive, uintptr(unsafe.Pointer(&coll))) < 0 {
			return
		}
		defer com(coll).release()
		var n uint32
		if com(coll).call(3, uintptr(unsafe.Pointer(&n))) < 0 {
			return
		}
		for i := uint32(0); i < n; i++ {
			var dev uintptr
			if com(coll).call(4, uintptr(i), uintptr(unsafe.Pointer(&dev))) < 0 {
				continue
			}
			if id := deviceID(com(dev)); id != "" {
				list = append(list, Device{ID: id, Name: deviceName(com(dev))})
			}
			com(dev).release()
		}
	})
	return list
}

// stream is one open device. A render stream asks fill for what to play; a capture stream hands what it heard to feed.
type stream struct {
	render   bool
	id       string
	channels int
	fill     func(pcm []int16)
	feed     func(pcm []int16)

	stop  atomic.Bool
	event uintptr
	done  chan struct{}
}

// openStream returns once the device is playing or recording, or has failed to.
func openStream(render bool, id string, channels int, fill, feed func([]int16)) (*stream, error) {
	s := &stream{render: render, id: id, channels: channels, fill: fill, feed: feed, done: make(chan struct{})}
	ready := make(chan error, 1)
	go s.run(ready)
	select {
	case err := <-ready:
		if err != nil {
			return nil, err
		}
	case <-time.After(openTimeout):
		s.Close()
		return nil, errors.New("the sound card did not answer")
	}
	return s, nil
}

func (s *stream) Close() {
	s.stop.Store(true)
	if s.event != 0 {
		callProc(procSetEvent, s.event)
	}
	select {
	case <-s.done:
	case <-time.After(2 * time.Second):
	}
}

func (s *stream) run(ready chan<- error) {
	defer close(s.done)
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if hr := callProc(procCoInitializeEx, 0, 0); hr >= 0 {
		defer callProc(procCoUninitialize)
	}
	var task uint32
	name, _ := syscall.UTF16PtrFromString("Audio")
	callProc(procAvSetMmThreadChars, uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&task)))

	ev, _, _ := syscall.SyscallN(procCreateEventW.Addr(), 0, 0, 0, 0)
	s.event = ev
	defer callProc(procCloseHandle, ev)

	started := false
	for {
		err := s.session(func() { started = true; ready <- nil })
		if !started {
			ready <- err
			return
		}
		if s.stop.Load() {
			return
		}
		time.Sleep(retryAfter)
	}
}

// session plays or records until the stream is closed or the device goes away.
func (s *stream) session(started func()) error {
	enum, err := newEnumerator()
	if err != nil {
		return err
	}
	defer enum.release()
	flow := eCapture
	if s.render {
		flow = eRender
	}
	dev, err := endpoint(enum, flow, s.id)
	if err != nil {
		return err
	}
	defer dev.release()

	var ac uintptr
	if err := check("Activate", dev.call(3, uintptr(unsafe.Pointer(&iidIAudioClient)), clsctxAll, 0, uintptr(unsafe.Pointer(&ac)))); err != nil {
		return err
	}
	client := com(ac)
	defer client.release()

	format := waveFormatEx{tag: waveFormatPCM, channels: uint16(s.channels), samplesPerSec: sampleRate, bitsPerSample: 16}
	format.blockAlign = format.channels * 2
	format.avgBytesPerSec = format.samplesPerSec * uint32(format.blockAlign)
	flags := uintptr(audclntAutoConvertPCM | audclntSRCQuality | audclntEventCallback)
	if err := check("Initialize", client.call(3, 0, flags, bufferHNS, 0, uintptr(unsafe.Pointer(&format)), 0)); err != nil {
		return err
	}
	if err := check("SetEventHandle", client.call(13, s.event)); err != nil {
		return err
	}
	var size uint32
	if err := check("GetBufferSize", client.call(4, uintptr(unsafe.Pointer(&size)))); err != nil {
		return err
	}
	iid := &iidIAudioCaptureClient
	if s.render {
		iid = &iidIAudioRenderClient
	}
	var sv uintptr
	if err := check("GetService", client.call(14, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&sv)))); err != nil {
		return err
	}
	service := com(sv)
	defer service.release()

	if s.render {
		if err := s.silence(service, size); err != nil {
			return err
		}
	}
	if err := check("Start", client.call(10)); err != nil {
		return err
	}
	defer client.call(11)
	started()

	if s.render {
		return s.playLoop(client, service, size)
	}
	return s.recordLoop(service)
}

func (s *stream) wait() {
	syscall.SyscallN(procWaitForSingleObject.Addr(), s.event, wakeEvery)
}

// silence fills the whole buffer with nothing so the device has something to play until the first real block.
func (s *stream) silence(service com, frames uint32) error {
	var data uintptr
	if err := check("GetBuffer", service.call(3, uintptr(frames), uintptr(unsafe.Pointer(&data)))); err != nil {
		return err
	}
	return check("ReleaseBuffer", service.call(4, uintptr(frames), audclntBufferSilent))
}

func (s *stream) playLoop(client, render com, size uint32) error {
	for !s.stop.Load() {
		s.wait()
		var padding uint32
		if err := check("GetCurrentPadding", client.call(6, uintptr(unsafe.Pointer(&padding)))); err != nil {
			return err
		}
		frames := size - padding
		if frames == 0 || s.stop.Load() {
			continue
		}
		var data uintptr
		if err := check("GetBuffer", render.call(3, uintptr(frames), uintptr(unsafe.Pointer(&data)))); err != nil {
			return err
		}
		s.fill(unsafe.Slice((*int16)(at(data)), int(frames)*s.channels))
		if err := check("ReleaseBuffer", render.call(4, uintptr(frames), 0)); err != nil {
			return err
		}
	}
	return nil
}

func (s *stream) recordLoop(capture com) error {
	var quiet []int16
	for !s.stop.Load() {
		s.wait()
		for !s.stop.Load() {
			var next uint32
			if err := check("GetNextPacketSize", capture.call(5, uintptr(unsafe.Pointer(&next)))); err != nil {
				return err
			}
			if next == 0 {
				break
			}
			var data uintptr
			var frames, flags uint32
			if err := check("GetBuffer", capture.call(3, uintptr(unsafe.Pointer(&data)), uintptr(unsafe.Pointer(&frames)), uintptr(unsafe.Pointer(&flags)), 0, 0)); err != nil {
				return err
			}
			n := int(frames) * s.channels
			if flags&audclntBufferSilent != 0 {
				if len(quiet) < n {
					quiet = make([]int16, n)
				}
				s.feed(quiet[:n])
			} else {
				s.feed(unsafe.Slice((*int16)(at(data)), n))
			}
			if err := check("ReleaseBuffer", capture.call(4, uintptr(frames))); err != nil {
				return err
			}
		}
	}
	return nil
}
