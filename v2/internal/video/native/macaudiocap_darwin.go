//go:build darwin

package native

// System audio with ScreenCaptureKit: a stream of its own that asks for sound only (the picture is as small and slow as
// the framework allows and nobody takes it), at 48 kHz stereo, with this program's own sound left out so a shared
// screen never carries the voices the mixer plays. macOS 13 or later; the Screen Recording permission applies.

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

const audioPermission = "Screen & System Audio Recording is not allowed for this program. Allow it in System Settings > Privacy & Security > Screen & System Audio Recording, then share again."

const (
	maSCOutputAudio     = 1
	maUserDeclined      = -3801
	maRate              = 48000
	maASBDFloat         = 1
	maASBDNonInterleave = 1 << 5
)

var ma struct {
	once sync.Once
	err  error

	numSamples                                                func(sb uintptr) int
	audioBufList                                              func(sb uintptr, needed *uintptr, list unsafe.Pointer, size uintptr, a1, a2 uintptr, flags uint32, block *uintptr) int32
	formatDesc                                                func(sb uintptr) uintptr
	asbdOf                                                    func(fd uintptr) unsafe.Pointer
	cfRelease                                                 func(o uintptr)
	preflight                                                 func() bool
	request                                                   func() bool
	queueCreate                                               func(label string, attr uintptr) uintptr
	poolPush                                                  func() uintptr
	poolPop                                                   func(uintptr)
	msgSendTime                                               func(objc.ID, objc.SEL, maCMTime)
	class                                                     objc.Class
	sinks                                                     sync.Map
	selAlloc, selInit, selRelease, selRetain, selCount, selAt objc.SEL
}

type maCMTime struct {
	Value int64
	Scale int32
	Flags uint32
	Epoch int64
}

func maLoad() error {
	ma.once.Do(func() {
		defer func() {
			if r := recover(); r != nil {
				ma.err = fmt.Errorf("system audio capture is not available: %v", r)
			}
		}()
		open := func(path string) uintptr {
			h, err := purego.Dlopen(path, purego.RTLD_LAZY|purego.RTLD_GLOBAL)
			if err != nil {
				panic(err)
			}
			return h
		}
		fw := func(n string) uintptr { return open("/System/Library/Frameworks/" + n + ".framework/" + n) }
		cm, cf, cg := fw("CoreMedia"), fw("CoreFoundation"), fw("CoreGraphics")
		fw("ScreenCaptureKit")
		fw("Foundation")
		libobjc, libSystem := open("/usr/lib/libobjc.A.dylib"), open("/usr/lib/libSystem.B.dylib")
		purego.RegisterLibFunc(&ma.numSamples, cm, "CMSampleBufferGetNumSamples")
		purego.RegisterLibFunc(&ma.audioBufList, cm, "CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer")
		purego.RegisterLibFunc(&ma.formatDesc, cm, "CMSampleBufferGetFormatDescription")
		purego.RegisterLibFunc(&ma.asbdOf, cm, "CMAudioFormatDescriptionGetStreamBasicDescription")
		purego.RegisterLibFunc(&ma.cfRelease, cf, "CFRelease")
		purego.RegisterLibFunc(&ma.preflight, cg, "CGPreflightScreenCaptureAccess")
		purego.RegisterLibFunc(&ma.request, cg, "CGRequestScreenCaptureAccess")
		purego.RegisterLibFunc(&ma.queueCreate, libSystem, "dispatch_queue_create")
		purego.RegisterLibFunc(&ma.poolPush, libobjc, "objc_autoreleasePoolPush")
		purego.RegisterLibFunc(&ma.poolPop, libobjc, "objc_autoreleasePoolPop")
		purego.RegisterLibFunc(&ma.msgSendTime, libobjc, "objc_msgSend")
		ma.selAlloc, ma.selInit, ma.selRelease = objc.RegisterName("alloc"), objc.RegisterName("init"), objc.RegisterName("release")
		ma.selRetain, ma.selCount, ma.selAt = objc.RegisterName("retain"), objc.RegisterName("count"), objc.RegisterName("objectAtIndex:")
		ma.class, ma.err = maRegisterSink()
	})
	return ma.err
}

func maRegisterSink() (objc.Class, error) {
	output := func(self objc.ID, _ objc.SEL, _ objc.ID, sb uintptr, typ int) {
		if typ != maSCOutputAudio {
			return
		}
		if v, ok := ma.sinks.Load(self); ok {
			v.(*macAudio).sample(sb)
		}
	}
	stopped := func(self objc.ID, _ objc.SEL, _ objc.ID, err objc.ID) {
		if v, ok := ma.sinks.Load(self); ok {
			v.(*macAudio).ended(err)
		}
	}
	var protocols []*objc.Protocol
	for _, n := range []string{"SCStreamOutput", "SCStreamDelegate"} {
		if p := objc.GetProtocol(n); p != nil {
			protocols = append(protocols, p)
		}
	}
	return objc.RegisterClass("HarmonyAudioSink", objc.GetClass("NSObject"), protocols, nil, []objc.MethodDef{
		{Cmd: objc.RegisterName("stream:didOutputSampleBuffer:ofType:"), Fn: output},
		{Cmd: objc.RegisterName("stream:didStopWithError:"), Fn: stopped},
	})
}

type macAudio struct {
	onPCM func([]int16)

	closed atomic.Bool
	stop   func()

	list []byte
	pcm  []int16
	skip int
}

func startAudioCapture(p AudioCaptureParams, onPCM func([]int16)) (AudioCapture, error) {
	if err := maLoad(); err != nil {
		return nil, err
	}
	if !ma.preflight() {
		ma.request()
		return nil, errors.New(audioPermission)
	}
	a := &macAudio{skip: 2, onPCM: onPCM, list: make([]byte, 512), pcm: make([]int16, 0, 4096)}
	if err := a.start(p); err != nil {
		return nil, err
	}
	return a, nil
}

func (a *macAudio) Close() {
	if a.closed.Swap(true) {
		return
	}
	if a.stop != nil {
		a.stop()
	}
}

func (a *macAudio) ended(err objc.ID) {
	if a.closed.Load() {
		return
	}
	a.closed.Store(true)
}

func maClass(name string) objc.ID { return objc.ID(objc.GetClass(name)) }

func maRelease(o objc.ID) {
	if o != 0 {
		o.Send(ma.selRelease)
	}
}

func maErrText(err objc.ID) string {
	if err == 0 {
		return "unknown error"
	}
	return fmt.Sprintf("%s (code %d)", maString(objc.Send[objc.ID](err, objc.RegisterName("localizedDescription"))), objc.Send[int](err, objc.RegisterName("code")))
}

func maString(s objc.ID) string {
	if s == 0 {
		return ""
	}
	p := objc.Send[uintptr](s, objc.RegisterName("UTF8String"))
	n := 0
	for *(*byte)(unsafe.Add(*(*unsafe.Pointer)(unsafe.Pointer(&p)), n)) != 0 {
		n++
	}
	return string(unsafe.Slice(*(**byte)(unsafe.Pointer(&p)), n))
}

func maErrOrEmpty(err objc.ID) string {
	if err == 0 {
		return ""
	}
	if objc.Send[int](err, objc.RegisterName("code")) == maUserDeclined {
		return audioPermission
	}
	return "ScreenCaptureKit: " + maErrText(err)
}

func maWait[T any](ch <-chan T, d time.Duration) (T, error) {
	select {
	case v := <-ch:
		return v, nil
	case <-time.After(d):
		var zero T
		return zero, errors.New("ScreenCaptureKit did not answer")
	}
}

// maContent is the shareable content, retained; the caller releases it.
func maContent() (objc.ID, error) {
	type result struct {
		content objc.ID
		err     string
	}
	ch := make(chan result, 1)
	blk := objc.NewBlock(func(_ objc.Block, content, err objc.ID) {
		if content != 0 {
			content.Send(ma.selRetain)
		}
		ch <- result{content, maErrOrEmpty(err)}
	})
	maClass("SCShareableContent").Send(objc.RegisterName("getShareableContentWithCompletionHandler:"), blk)
	r, err := maWait(ch, 15*time.Second)
	blk.Release()
	if err != nil {
		return 0, err
	}
	if r.content == 0 {
		return 0, errors.New(r.err)
	}
	return r.content, nil
}

func maItems(array objc.ID) []objc.ID {
	if array == 0 {
		return nil
	}
	out := make([]objc.ID, objc.Send[uint](array, ma.selCount))
	for i := range out {
		out[i] = objc.Send[objc.ID](array, ma.selAt, uint(i))
	}
	return out
}

func maNSArray(objs ...objc.ID) objc.ID {
	if len(objs) == 0 {
		return maClass("NSArray").Send(objc.RegisterName("array"))
	}
	return maClass("NSArray").Send(objc.RegisterName("arrayWithObjects:count:"), unsafe.Pointer(&objs[0]), uint(len(objs)))
}

func maApp(content objc.ID, pid int) objc.ID {
	for _, app := range maItems(objc.Send[objc.ID](content, objc.RegisterName("applications"))) {
		if objc.Send[int32](app, objc.RegisterName("processID")) == int32(pid) {
			return app
		}
	}
	return 0
}

func (a *macAudio) start(p AudioCaptureParams) error {
	runtime.LockOSThread()
	pool := ma.poolPush()
	defer func() {
		ma.poolPop(pool)
		runtime.UnlockOSThread()
	}()

	content, err := maContent()
	if err != nil {
		return err
	}
	defer maRelease(content)
	displays := maItems(objc.Send[objc.ID](content, objc.RegisterName("displays")))
	if len(displays) == 0 {
		return errors.New("there is no display to capture audio from")
	}
	var filter objc.ID
	switch {
	case p.PID > 0:
		app := maApp(content, p.PID)
		if app == 0 {
			return fmt.Errorf("the application %d has no audio ScreenCaptureKit can see", p.PID)
		}
		filter = maClass("SCContentFilter").Send(ma.selAlloc).Send(objc.RegisterName("initWithDisplay:includingApplications:exceptingWindows:"), displays[0], maNSArray(app), maNSArray())
	case p.ExcludePID > 0 && p.ExcludePID != os.Getpid() && maApp(content, p.ExcludePID) != 0:
		filter = maClass("SCContentFilter").Send(ma.selAlloc).Send(objc.RegisterName("initWithDisplay:excludingApplications:exceptingWindows:"), displays[0], maNSArray(maApp(content, p.ExcludePID)), maNSArray())
	default:
		filter = maClass("SCContentFilter").Send(ma.selAlloc).Send(objc.RegisterName("initWithDisplay:excludingWindows:"), displays[0], maNSArray())
	}

	cfg := maClass("SCStreamConfiguration").Send(ma.selAlloc).Send(ma.selInit)
	cfg.Send(objc.RegisterName("setWidth:"), uint(2))
	cfg.Send(objc.RegisterName("setHeight:"), uint(2))
	ma.msgSendTime(cfg, objc.RegisterName("setMinimumFrameInterval:"), maCMTime{Value: 1, Scale: 1, Flags: 1})
	cfg.Send(objc.RegisterName("setCapturesAudio:"), true)
	cfg.Send(objc.RegisterName("setExcludesCurrentProcessAudio:"), true)
	cfg.Send(objc.RegisterName("setSampleRate:"), int(maRate))
	cfg.Send(objc.RegisterName("setChannelCount:"), int(2))

	sink := objc.ID(ma.class).Send(ma.selAlloc).Send(ma.selInit)
	ma.sinks.Store(sink, a)
	queue := objc.ID(ma.queueCreate("harmony.capture.audio\x00", 0))
	stream := maClass("SCStream").Send(ma.selAlloc).Send(objc.RegisterName("initWithFilter:configuration:delegate:"), filter, cfg, sink)
	teardown := func() {
		ma.sinks.Delete(sink)
		for _, o := range []objc.ID{stream, filter, cfg, sink, queue} {
			maRelease(o)
		}
	}
	if stream == 0 {
		teardown()
		return errors.New("ScreenCaptureKit could not make a stream")
	}
	addErr := new(objc.ID)
	if !objc.Send[bool](stream, objc.RegisterName("addStreamOutput:type:sampleHandlerQueue:error:"), sink, maSCOutputAudio, queue, unsafe.Pointer(addErr)) {
		teardown()
		return fmt.Errorf("ScreenCaptureKit refused the audio output (it needs macOS 13): %s", maErrText(*addErr))
	}
	started := make(chan string, 1)
	blk := objc.NewBlock(func(_ objc.Block, err objc.ID) { started <- maErrOrEmpty(err) })
	stream.Send(objc.RegisterName("startCaptureWithCompletionHandler:"), blk)
	msg, werr := maWait(started, 10*time.Second)
	blk.Release()
	if werr != nil {
		teardown()
		return werr
	}
	if msg != "" {
		teardown()
		return errors.New(msg)
	}
	a.stop = func() {
		done := make(chan struct{}, 1)
		b := objc.NewBlock(func(objc.Block, objc.ID) { done <- struct{}{} })
		stream.Send(objc.RegisterName("stopCaptureWithCompletionHandler:"), b)
		maWait(done, 3*time.Second)
		b.Release()
		teardown()
	}
	return nil
}

// sample turns one buffer of sound into 48 kHz stereo 16 bit and hands it on.
func (a *macAudio) sample(sb uintptr) {
	if a.closed.Load() || sb == 0 {
		return
	}
	frames := ma.numSamples(sb)
	if frames <= 0 {
		return
	}
	if a.skip > 0 { // the stream's first buffers start with a click
		a.skip--
		return
	}
	var needed, block uintptr
	ma.audioBufList(sb, &needed, nil, 0, 0, 0, 0, nil)
	if needed == 0 || needed > uintptr(cap(a.list)) {
		a.list = make([]byte, max(needed, 40))
	}
	list := a.list[:needed]
	if st := ma.audioBufList(sb, nil, unsafe.Pointer(&list[0]), needed, 0, 0, 0, &block); st != 0 {
		return
	}
	defer ma.cfRelease(block)

	flags := uint32(maASBDFloat)
	bits := uint32(32)
	if fd := ma.formatDesc(sb); fd != 0 {
		if d := ma.asbdOf(fd); d != nil {
			flags = *(*uint32)(unsafe.Add(d, 12))
			bits = *(*uint32)(unsafe.Add(d, 32))
		}
	}
	count := *(*uint32)(unsafe.Pointer(&list[0]))
	type buffer struct {
		channels, size uint32
		data           uintptr
	}
	buffers := unsafe.Slice((*buffer)(unsafe.Pointer(&list[8])), count)
	if cap(a.pcm) < frames*2 {
		a.pcm = make([]int16, 0, frames*2)
	}
	out := a.pcm[:frames*2]
	read := func(b buffer, i int) float32 {
		p := unsafe.Add(*(*unsafe.Pointer)(unsafe.Pointer(&b.data)), i*int(bits/8))
		if flags&maASBDFloat != 0 {
			return *(*float32)(p)
		}
		return float32(*(*int16)(p)) / 32768
	}
	switch {
	case count >= 2 && flags&maASBDNonInterleave != 0:
		for i := 0; i < frames; i++ {
			out[2*i], out[2*i+1] = maClamp(read(buffers[0], i)), maClamp(read(buffers[1], i))
		}
	case count >= 1 && buffers[0].channels >= 2:
		stride := int(buffers[0].channels)
		for i := 0; i < frames; i++ {
			out[2*i], out[2*i+1] = maClamp(read(buffers[0], i*stride)), maClamp(read(buffers[0], i*stride+1))
		}
	case count >= 1:
		for i := 0; i < frames; i++ {
			v := maClamp(read(buffers[0], i))
			out[2*i], out[2*i+1] = v, v
		}
	default:
		return
	}
	a.onPCM(out)
}

func maClamp(v float32) int16 {
	switch {
	case v >= 1:
		return 32767
	case v <= -1:
		return -32768
	}
	return int16(v * 32767)
}

func listAudioApps() []AudioApp {
	self := AudioApp{PID: os.Getpid(), Name: "Harmony", Self: true}
	if maLoad() != nil || !ma.preflight() {
		return []AudioApp{self}
	}
	runtime.LockOSThread()
	pool := ma.poolPush()
	defer func() {
		ma.poolPop(pool)
		runtime.UnlockOSThread()
	}()
	content, err := maContent()
	if err != nil {
		return []AudioApp{self}
	}
	defer maRelease(content)
	apps := []AudioApp{self}
	for _, app := range maItems(objc.Send[objc.ID](content, objc.RegisterName("applications"))) {
		pid := int(objc.Send[int32](app, objc.RegisterName("processID")))
		if name := maString(objc.Send[objc.ID](app, objc.RegisterName("applicationName"))); name != "" && pid != self.PID {
			apps = append(apps, AudioApp{PID: pid, Name: name})
		}
	}
	return apps
}

func audioSupport() AudioSupport {
	if err := maLoad(); err != nil {
		return AudioSupport{Reason: err.Error()}
	}
	if objc.GetClass("SCStreamConfiguration") == 0 {
		return AudioSupport{Reason: "System audio needs macOS 13 or later."}
	}
	return AudioSupport{System: true, Exclude: true, App: true, ExcludesSelf: true}
}

func windowAudioPID(window uint32) int {
	if maLoad() != nil || !ma.preflight() {
		return 0
	}
	runtime.LockOSThread()
	pool := ma.poolPush()
	defer func() {
		ma.poolPop(pool)
		runtime.UnlockOSThread()
	}()
	content, err := maContent()
	if err != nil {
		return 0
	}
	defer maRelease(content)
	for _, w := range maItems(objc.Send[objc.ID](content, objc.RegisterName("windows"))) {
		if objc.Send[uint32](w, objc.RegisterName("windowID")) != window {
			continue
		}
		if app := objc.Send[objc.ID](w, objc.RegisterName("owningApplication")); app != 0 {
			return int(objc.Send[int32](app, objc.RegisterName("processID")))
		}
	}
	return 0
}
