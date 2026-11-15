//go:build windows

package native

// System audio on Windows through WASAPI. Everything the default output plays is its loopback; one application's sound, or
// everything but one application's, is the process loopback of Windows 10 2004 and later, which is made through an
// asynchronous activation (winaudiocap_process.go). Both are read the same way, by a goroutine of their own that stays on
// its COM thread, and converted to 48 kHz stereo (audioconv.go).

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
	audclntSharedMode     = 0
	audclntLoopback       = 0x00020000
	audclntEventCallback  = 0x00040000
	audclntAutoConvertPCM = 0x80000000
	audclntSRCQuality     = 0x08000000
	audclntBufferSilent   = 0x2
	waveFormatPCM         = 1
	waveFormatFloat       = 3
	waveFormatExtensible  = 0xFFFE
	loopbackBufferHNS     = 1000000
	loopbackPoll          = 10 * time.Millisecond
	waitObject0           = 0
)

var (
	clsidMMDeviceEnumerator = mustGUID("bcde0395-e52f-467c-8e3d-c4579291692e")
	iidIMMDeviceEnumerator  = mustGUID("a95664d2-9614-4f35-a746-de8db63617e6")
	iidIAudioClient         = mustGUID("1cb9ad4c-dbfa-4c32-b178-c2f568a703b2")
	iidIAudioCaptureClient  = mustGUID("c8adbd64-e71e-48a0-a4de-185c395cd317")

	dllKernel32             = syscall.NewLazyDLL("kernel32.dll")
	procCreateEventW        = dllKernel32.NewProc("CreateEventW")
	procWaitForSingleObject = dllKernel32.NewProc("WaitForSingleObject")
	procCloseHandle         = dllKernel32.NewProc("CloseHandle")
)

type waveFormatEx struct {
	tag            uint16
	channels       uint16
	samplesPerSec  uint32
	avgBytesPerSec uint32
	blockAlign     uint16
	bitsPerSample  uint16
	cbSize         uint16
}

type winAudio struct {
	onPCM func([]int16)
	stop  atomic.Bool
	done  chan struct{}
}

// startAudioCapture opens the capture on its own goroutine, which reports whether it came up before it starts reading.
func startAudioCapture(p AudioCaptureParams, onPCM func([]int16)) (AudioCapture, error) {
	a := &winAudio{onPCM: onPCM, done: make(chan struct{})}
	ready := make(chan error, 1)
	go a.run(p, ready)
	select {
	case err := <-ready:
		if err != nil {
			return nil, err
		}
	case <-time.After(10 * time.Second):
		a.stop.Store(true)
		return nil, errors.New("WASAPI did not answer")
	}
	return a, nil
}

func (a *winAudio) Close() {
	a.stop.Store(true)
	select {
	case <-a.done:
	case <-time.After(2 * time.Second):
	}
}

// openDefaultLoopback is the audio client of the default output, initialised for loopback in the output's own format.
func openDefaultLoopback() (client com, format pcmFormat, err error) {
	enum, err := coCreateInstance(&clsidMMDeviceEnumerator, &iidIMMDeviceEnumerator)
	if err != nil {
		return 0, format, err
	}
	defer enum.release()
	var dev uintptr
	if hr := enum.call(4, 0, 0, uintptr(unsafe.Pointer(&dev))); hr.failed() { // GetDefaultAudioEndpoint(eRender, eConsole)
		return 0, format, hr.err("GetDefaultAudioEndpoint (is there a sound output?)")
	}
	defer com(dev).release()
	var ac uintptr
	if hr := com(dev).call(3, iidIAudioClient.p(), clsctxAll, 0, uintptr(unsafe.Pointer(&ac))); hr.failed() { // IMMDevice::Activate
		return 0, format, hr.err("IMMDevice.Activate")
	}
	client = com(ac)
	var mix uintptr
	if hr := client.call(8, uintptr(unsafe.Pointer(&mix))); hr.failed() { // GetMixFormat
		client.release()
		return 0, format, hr.err("GetMixFormat")
	}
	defer coTaskMemFree(mix)
	format, err = formatOf(mix)
	if err != nil {
		client.release()
		return 0, format, err
	}
	if hr := client.call(3, audclntSharedMode, audclntLoopback, loopbackBufferHNS, 0, mix, 0); hr.failed() { // Initialize
		client.release()
		return 0, format, hr.err("IAudioClient.Initialize (loopback)")
	}
	return client, format, nil
}

// formatOf reads a WAVEFORMATEX or WAVEFORMATEXTENSIBLE.
func formatOf(p uintptr) (pcmFormat, error) {
	w := (*waveFormatEx)(at(p))
	f := pcmFormat{rate: int(w.samplesPerSec), channels: int(w.channels), bits: int(w.bitsPerSample)}
	tag := w.tag
	if tag == waveFormatExtensible {
		tag = *(*uint16)(at(p + unsafe.Sizeof(*w) + 8)) // the first word of the sub-format GUID, after the valid bits and the channel mask
	}
	switch tag {
	case waveFormatFloat:
		f.float = true
	case waveFormatPCM:
	default:
		return f, fmt.Errorf("the output plays in a format (%d) that is not PCM", tag)
	}
	if f.rate <= 0 || f.channels <= 0 || f.bits%8 != 0 {
		return f, errors.New("the output reports a format that cannot be read")
	}
	return f, nil
}

func (a *winAudio) run(p AudioCaptureParams, ready chan<- error) {
	defer close(a.done)
	end, err := comOnly()
	if err != nil {
		ready <- err
		return
	}
	defer end()

	var client com
	var format pcmFormat
	var event uintptr
	if p.PID != 0 || p.ExcludePID != 0 {
		client, format, event, err = openProcessLoopback(p)
		if err != nil && p.PID == 0 {
			client, format, err = openDefaultLoopback()
		}
	} else {
		client, format, err = openDefaultLoopback()
	}
	if err != nil {
		ready <- err
		return
	}
	defer client.release()
	if event != 0 {
		defer callProc(procCloseHandle, event)
	}
	var cc uintptr
	if hr := client.call(14, iidIAudioCaptureClient.p(), uintptr(unsafe.Pointer(&cc))); hr.failed() { // GetService
		ready <- hr.err("GetService(IAudioCaptureClient)")
		return
	}
	capture := com(cc)
	defer capture.release()
	if hr := client.call(10); hr.failed() { // Start
		ready <- hr.err("IAudioClient.Start")
		return
	}
	defer client.call(11) // Stop
	ready <- nil

	conv := newAudioConv(format)
	for !a.stop.Load() {
		if event != 0 {
			r, _, _ := syscall.SyscallN(procWaitForSingleObject.Addr(), event, 100)
			if r != waitObject0 {
				continue
			}
		} else {
			time.Sleep(loopbackPoll)
		}
		if !a.drain(capture, format, conv) {
			return
		}
	}
}

// drain hands over every packet the device has; false when the device is gone.
func (a *winAudio) drain(capture com, format pcmFormat, conv *audioConv) bool {
	for !a.stop.Load() {
		var frames uint32
		if hr := capture.call(5, uintptr(unsafe.Pointer(&frames))); hr.failed() { // GetNextPacketSize
			return false
		}
		if frames == 0 {
			return true
		}
		var data uintptr
		var n, flags uint32
		if hr := capture.call(3, uintptr(unsafe.Pointer(&data)), uintptr(unsafe.Pointer(&n)), uintptr(unsafe.Pointer(&flags)), 0, 0); hr.failed() { // GetBuffer
			return false
		}
		silent := flags&audclntBufferSilent != 0
		var block []byte
		if !silent {
			block = bytesAt(data, int(n)*format.channels*format.bits/8)
		}
		if pcm := conv.convert(block, int(n), silent); len(pcm) > 0 {
			a.onPCM(pcm)
		}
		capture.call(4, uintptr(n)) // ReleaseBuffer
	}
	return true
}

// comOnly readies the calling goroutine for COM, on its own thread, without Media Foundation.
func comOnly() (end func(), err error) {
	runtime.LockOSThread()
	hr := callProc(procCoInitializeEx, 0, 0)
	inited := !hr.failed()
	if hr.failed() && hr != hrChangedMode {
		runtime.UnlockOSThread()
		return nil, hr.err("CoInitializeEx")
	}
	return func() {
		if inited {
			callProc(procCoUninitialize)
		}
		runtime.UnlockOSThread()
	}, nil
}

func listAudioApps() []AudioApp { return winAudioApps() }

func audioSupport() AudioSupport {
	return AudioSupport{System: true, Exclude: processLoopbackSupported(), App: processLoopbackSupported()}
}

func windowAudioPID(uint32) int { return 0 }
