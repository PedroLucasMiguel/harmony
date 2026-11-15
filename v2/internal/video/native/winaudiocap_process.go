//go:build windows

package native

// Process loopback (Windows 10 2004 and later): the audio client of one application's tree, or of everything but one
// application's tree, made by ActivateAudioInterfaceAsync. The completion is a COM object of ours that Windows calls on its
// own thread; the client comes back to the capturing goroutine through a channel. The list of applications for the picker
// is the programs that have a window.

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	vtBlob                  = 0x41
	activationProcessLoop   = 1
	loopbackIncludeTree     = 0
	loopbackExcludeTree     = 1
	processQueryLimitedInfo = 0x1000
	processLoopbackMinBuild = 19041
	activationTimeout       = 10 * time.Second
	processLoopbackDevice   = `VAD\Process_Loopback`
	maxImagePath            = 1024
	windowTitleChars        = 256
)

var (
	dllMmdevapi                     = syscall.NewLazyDLL("mmdevapi.dll")
	dllUser32                       = syscall.NewLazyDLL("user32.dll")
	procActivateAudioInterfaceAsync = dllMmdevapi.NewProc("ActivateAudioInterfaceAsync")
	procEnumWindows                 = dllUser32.NewProc("EnumWindows")
	procIsWindowVisible             = dllUser32.NewProc("IsWindowVisible")
	procGetWindowThreadProcessID    = dllUser32.NewProc("GetWindowThreadProcessId")
	procGetWindowTextW              = dllUser32.NewProc("GetWindowTextW")
	procOpenProcess                 = dllKernel32.NewProc("OpenProcess")
	procQueryFullProcessImageNameW  = dllKernel32.NewProc("QueryFullProcessImageNameW")
	procRtlGetVersion               = syscall.NewLazyDLL("ntdll.dll").NewProc("RtlGetVersion")

	iidActivateCompletionHandler = mustGUID("41d949ab-9862-444a-80f6-c261334da5eb")
	iidAgileObject               = mustGUID("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90")
)

type propVariantBlob struct {
	vt   uint16
	_    [3]uint16
	size uint32
	_    uint32
	data uintptr
}

type processLoopbackParams struct {
	activationType uint32
	targetPID      uint32
	mode           uint32
}

type activation struct {
	hr     hresult
	client com
}

// activationHandler is laid out as a COM object: the first word is the address of the method table.
type activationHandler struct {
	vtbl uintptr
	ch   chan activation
}

var activationTable struct {
	once sync.Once
	vtbl [4]uintptr // QueryInterface, AddRef, Release, ActivateCompleted
	keep []*activationHandler
	mu   sync.Mutex
}

func newActivationHandler() *activationHandler {
	t := &activationTable
	t.once.Do(func() {
		t.vtbl[0] = syscall.NewCallback(activationQueryInterface)
		t.vtbl[1] = syscall.NewCallback(func(this uintptr) uintptr { return 2 })
		t.vtbl[2] = syscall.NewCallback(func(this uintptr) uintptr { return 1 })
		t.vtbl[3] = syscall.NewCallback(activationCompleted)
	})
	h := &activationHandler{vtbl: uintptr(unsafe.Pointer(&t.vtbl)), ch: make(chan activation, 1)}
	t.mu.Lock()
	t.keep = append(t.keep, h)
	t.mu.Unlock()
	return h
}

func activationQueryInterface(this, riid, ppv uintptr) uintptr {
	g := (*guid)(at(riid))
	if *g == iidIUnknown || *g == iidActivateCompletionHandler || *g == iidAgileObject {
		*(*uintptr)(at(ppv)) = this
		return 0
	}
	*(*uintptr)(at(ppv)) = 0
	return 0x80004002 // E_NOINTERFACE
}

func activationCompleted(this, op uintptr) uintptr {
	h := (*activationHandler)(at(this))
	var result hresult
	var unk uintptr
	hr := com(op).call(3, uintptr(unsafe.Pointer(&result)), uintptr(unsafe.Pointer(&unk))) // GetActivateResult
	out := activation{hr: hr}
	if !hr.failed() {
		out.hr = result
		if !result.failed() {
			out.client = com(unk)
		}
	}
	select {
	case h.ch <- out:
	default:
	}
	return 0
}

func processLoopbackSupported() bool {
	var info struct {
		size                uint32
		major, minor, build uint32
		platform            uint32
		csd                 [128]uint16
	}
	info.size = uint32(unsafe.Sizeof(info))
	if err := procRtlGetVersion.Find(); err != nil {
		return false
	}
	syscall.SyscallN(procRtlGetVersion.Addr(), uintptr(unsafe.Pointer(&info)))
	return info.major > 10 || info.major == 10 && info.build >= processLoopbackMinBuild
}

// openProcessLoopback is the audio client of one application's sound (PID) or of everything but one application's
// (ExcludePID), taking 48 kHz stereo 16 bit from the system and signalling the event when a packet is ready.
func openProcessLoopback(p AudioCaptureParams) (client com, format pcmFormat, event uintptr, err error) {
	format = pcmFormat{rate: 48000, channels: 2, bits: 16}
	if !processLoopbackSupported() {
		return 0, format, 0, errors.New("one application's sound needs Windows 10 version 2004 or later")
	}
	params := processLoopbackParams{activationType: activationProcessLoop, targetPID: uint32(p.PID), mode: loopbackIncludeTree}
	if p.PID == 0 {
		params.targetPID, params.mode = uint32(p.ExcludePID), loopbackExcludeTree
	}
	blob := propVariantBlob{vt: vtBlob, size: uint32(unsafe.Sizeof(params)), data: uintptr(unsafe.Pointer(&params))}
	handler := newActivationHandler()
	path, _ := syscall.UTF16PtrFromString(processLoopbackDevice)
	var op uintptr
	if hr := callProc(procActivateAudioInterfaceAsync, uintptr(unsafe.Pointer(path)), iidIAudioClient.p(), uintptr(unsafe.Pointer(&blob)), uintptr(unsafe.Pointer(handler)), uintptr(unsafe.Pointer(&op))); hr.failed() {
		return 0, format, 0, hr.err("ActivateAudioInterfaceAsync")
	}
	defer com(op).release()
	select {
	case a := <-handler.ch:
		if a.hr.failed() {
			return 0, format, 0, a.hr.err("process loopback activation")
		}
		client = a.client
	case <-time.After(activationTimeout):
		return 0, format, 0, errors.New("process loopback did not answer")
	}
	runtime.KeepAlive(&params)
	runtime.KeepAlive(&blob)

	w := waveFormatEx{tag: waveFormatPCM, channels: 2, samplesPerSec: 48000, avgBytesPerSec: 48000 * 4, blockAlign: 4, bitsPerSample: 16}
	flags := uintptr(audclntLoopback | audclntEventCallback | audclntAutoConvertPCM | audclntSRCQuality)
	if hr := client.call(3, audclntSharedMode, flags, 0, 0, uintptr(unsafe.Pointer(&w)), 0); hr.failed() { // Initialize
		client.release()
		return 0, format, 0, hr.err("IAudioClient.Initialize (process loopback)")
	}
	r, _, _ := syscall.SyscallN(procCreateEventW.Addr(), 0, 0, 0, 0)
	if r == 0 {
		client.release()
		return 0, format, 0, errors.New("CreateEvent failed")
	}
	if hr := client.call(13, r); hr.failed() { // SetEventHandle
		callProc(procCloseHandle, r)
		client.release()
		return 0, format, 0, hr.err("SetEventHandle")
	}
	return client, format, r, nil
}

// winAudioApps lists the programs that have a visible window, this one first.
func winAudioApps() []AudioApp {
	self := AudioApp{PID: os.Getpid(), Name: "Harmony", Self: true}
	seen := map[int]string{}
	cb := syscall.NewCallback(func(hwnd, _ uintptr) uintptr {
		if r, _, _ := syscall.SyscallN(procIsWindowVisible.Addr(), hwnd); r == 0 {
			return 1
		}
		var pid uint32
		syscall.SyscallN(procGetWindowThreadProcessID.Addr(), hwnd, uintptr(unsafe.Pointer(&pid)))
		if int(pid) == self.PID || seen[int(pid)] != "" {
			return 1
		}
		title := make([]uint16, windowTitleChars)
		n, _, _ := syscall.SyscallN(procGetWindowTextW.Addr(), hwnd, uintptr(unsafe.Pointer(&title[0])), windowTitleChars)
		if n == 0 {
			return 1
		}
		if name := imageName(pid); name != "" {
			seen[int(pid)] = name
		}
		return 1
	})
	syscall.SyscallN(procEnumWindows.Addr(), cb, 0)
	out := make([]AudioApp, 0, len(seen))
	for pid, name := range seen {
		out = append(out, AudioApp{PID: pid, Name: name})
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return append([]AudioApp{self}, out...)
}

func imageName(pid uint32) string {
	h, _, _ := syscall.SyscallN(procOpenProcess.Addr(), processQueryLimitedInfo, 0, uintptr(pid))
	if h == 0 {
		return ""
	}
	defer callProc(procCloseHandle, h)
	buf := make([]uint16, maxImagePath)
	n := uint32(len(buf))
	if r, _, _ := syscall.SyscallN(procQueryFullProcessImageNameW.Addr(), h, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n))); r == 0 {
		return ""
	}
	return strings.TrimSuffix(filepath.Base(syscall.UTF16ToString(buf[:n])), ".exe")
}
