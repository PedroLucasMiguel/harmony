//go:build darwin

package native

// The Objective-C side of the macOS capture, through purego's objc package: frameworks, selectors, string and array
// helpers, and the one class that receives sample buffers from ScreenCaptureKit and AVFoundation.

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

var mc struct {
	once sync.Once
	err  error

	libobjc, libSystem, avf, sck, cg, fnd uintptr

	poolPush            func() uintptr
	poolPop             func(uintptr)
	msgSendTime         func(objc.ID, objc.SEL, cmTime)
	dispatchQueueCreate func(label string, attr uintptr) uintptr
	cgPreflight         func() bool
	cgRequest           func() bool
	cgMainDisplay       func() uint32

	sink objc.Class

	selAlloc, selInit, selRelease, selCount, selObjectAtIndex, selUTF8String, selStringWithUTF8 objc.SEL
	selLocalizedDescription, selCode, selArrayWithObjects, selDefaultCenter, selRemoveObserver  objc.SEL
	selAddObserver, selDictWithObjects                                                          objc.SEL
}

func mcLoad() error {
	mc.once.Do(func() {
		defer func() {
			if r := recover(); r != nil {
				mc.err = fmt.Errorf("capture is not available: %v", r)
			}
		}()
		if mc.err = mxLoad(); mc.err != nil {
			return
		}
		open := func(path string) uintptr {
			h, err := purego.Dlopen(path, purego.RTLD_LAZY|purego.RTLD_GLOBAL)
			if err != nil {
				panic(err)
			}
			return h
		}
		fw := func(n string) uintptr { return open("/System/Library/Frameworks/" + n + ".framework/" + n) }
		mc.libobjc = open("/usr/lib/libobjc.A.dylib")
		mc.libSystem = open("/usr/lib/libSystem.B.dylib")
		mc.fnd = fw("Foundation")
		mc.avf = fw("AVFoundation")
		mc.cg = fw("CoreGraphics")
		purego.RegisterLibFunc(&mc.poolPush, mc.libobjc, "objc_autoreleasePoolPush")
		purego.RegisterLibFunc(&mc.poolPop, mc.libobjc, "objc_autoreleasePoolPop")
		purego.RegisterLibFunc(&mc.msgSendTime, mc.libobjc, "objc_msgSend")
		purego.RegisterLibFunc(&mc.dispatchQueueCreate, mc.libSystem, "dispatch_queue_create")
		purego.RegisterLibFunc(&mc.cgPreflight, mc.cg, "CGPreflightScreenCaptureAccess")
		purego.RegisterLibFunc(&mc.cgRequest, mc.cg, "CGRequestScreenCaptureAccess")
		purego.RegisterLibFunc(&mc.cgMainDisplay, mc.cg, "CGMainDisplayID")
		// ScreenCaptureKit is loaded when a screen capture starts: a camera must not need it.

		for sel, name := range map[*objc.SEL]string{
			&mc.selAlloc: "alloc", &mc.selInit: "init", &mc.selRelease: "release", &mc.selCount: "count",
			&mc.selObjectAtIndex: "objectAtIndex:", &mc.selUTF8String: "UTF8String", &mc.selStringWithUTF8: "stringWithUTF8String:",
			&mc.selLocalizedDescription: "localizedDescription", &mc.selCode: "code", &mc.selArrayWithObjects: "arrayWithObjects:count:",
			&mc.selDefaultCenter: "defaultCenter", &mc.selRemoveObserver: "removeObserver:",
			&mc.selAddObserver: "addObserverForName:object:queue:usingBlock:", &mc.selDictWithObjects: "dictionaryWithObjects:forKeys:count:",
		} {
			*sel = objc.RegisterName(name)
		}
		mc.sink, mc.err = mcRegisterSink()
	})
	return mc.err
}

func mcClass(name string) objc.ID { return objc.ID(objc.GetClass(name)) }

func mcNewObject(class string) objc.ID {
	return mcClass(class).Send(mc.selAlloc).Send(mc.selInit)
}

func mcNSString(s string) objc.ID {
	return mcClass("NSString").Send(mc.selStringWithUTF8, s+"\x00")
}

func mcCString(p uintptr) string {
	if p == 0 {
		return ""
	}
	n := 0
	for *(*byte)(unsafe.Add(*(*unsafe.Pointer)(unsafe.Pointer(&p)), n)) != 0 {
		n++
	}
	return string(mxBytes(p, n))
}

func mcGoString(s objc.ID) string {
	if s == 0 {
		return ""
	}
	return mcCString(objc.Send[uintptr](s, mc.selUTF8String))
}

func mcArray(a objc.ID) []objc.ID {
	if a == 0 {
		return nil
	}
	n := int(objc.Send[uint](a, mc.selCount))
	out := make([]objc.ID, n)
	for i := range out {
		out[i] = objc.Send[objc.ID](a, mc.selObjectAtIndex, uint(i))
	}
	return out
}

// mcNSArray makes an autoreleased NSArray of objects.
func mcNSArray(objs ...objc.ID) objc.ID {
	if len(objs) == 0 {
		return mcClass("NSArray").Send(objc.RegisterName("array"))
	}
	return mcClass("NSArray").Send(mc.selArrayWithObjects, unsafe.Pointer(&objs[0]), uint(len(objs)))
}

func mcNSDictionary(keys, vals []objc.ID) objc.ID {
	return mcClass("NSDictionary").Send(mc.selDictWithObjects, unsafe.Pointer(&vals[0]), unsafe.Pointer(&keys[0]), uint(len(keys)))
}

func mcNSNumber(v int) objc.ID {
	return mcClass("NSNumber").Send(objc.RegisterName("numberWithInt:"), int32(v))
}

func mcErrorText(err objc.ID) string {
	if err == 0 {
		return "unknown error"
	}
	return fmt.Sprintf("%s (code %d)", mcGoString(objc.Send[objc.ID](err, mc.selLocalizedDescription)), objc.Send[int](err, mc.selCode))
}

// mcConstant reads an NSString constant a framework exports.
func mcConstant(lib uintptr, name string) objc.ID {
	p, err := purego.Dlsym(lib, name)
	if err != nil {
		return 0
	}
	return **(**objc.ID)(unsafe.Pointer(&p))
}

func mcQueue(label string) objc.ID { return objc.ID(mc.dispatchQueueCreate(label+"\x00", 0)) }

// mcWait waits for a completion block, never for ever.
func mcWait[T any](ch <-chan T, d time.Duration, what string) (T, error) {
	select {
	case v := <-ch:
		return v, nil
	case <-time.After(d):
		var zero T
		return zero, fmt.Errorf("%s did not answer in %v", what, d)
	}
}

// mcSinks finds the capture a sample buffer belongs to by the receiving object.
var mcSinks sync.Map // objc.ID -> *macCapture

// mcRegisterSink makes the class that takes sample buffers (ScreenCaptureKit's and AVFoundation's output protocols) and
// stream stops.
func mcRegisterSink() (objc.Class, error) {
	screen := func(self objc.ID, _ objc.SEL, _ objc.ID, sb uintptr, typ int) {
		if typ != 0 {
			return
		}
		if v, ok := mcSinks.Load(self); ok {
			v.(*macCapture).screenSample(sb)
		}
	}
	camera := func(self objc.ID, _ objc.SEL, _ objc.ID, sb uintptr, _ objc.ID) {
		if v, ok := mcSinks.Load(self); ok {
			v.(*macCapture).cameraSample(sb)
		}
	}
	stopped := func(self objc.ID, _ objc.SEL, _ objc.ID, err objc.ID) {
		if v, ok := mcSinks.Load(self); ok {
			v.(*macCapture).end(errors.New("the screen capture stopped: " + mcErrorText(err)))
		}
	}
	var protocols []*objc.Protocol
	for _, n := range []string{"SCStreamOutput", "SCStreamDelegate", "AVCaptureVideoDataOutputSampleBufferDelegate"} {
		if p := objc.GetProtocol(n); p != nil {
			protocols = append(protocols, p)
		}
	}
	return objc.RegisterClass("HarmonyCaptureSink", objc.GetClass("NSObject"), protocols, nil, []objc.MethodDef{
		{Cmd: objc.RegisterName("stream:didOutputSampleBuffer:ofType:"), Fn: screen},
		{Cmd: objc.RegisterName("captureOutput:didOutputSampleBuffer:fromConnection:"), Fn: camera},
		{Cmd: objc.RegisterName("stream:didStopWithError:"), Fn: stopped},
	})
}

// mcObserve calls fn when the named notification is posted; the returned token goes to mcUnobserve.
func mcObserve(name objc.ID, object objc.ID, fn func()) (token, block objc.ID) {
	if name == 0 {
		return 0, 0
	}
	b := objc.NewBlock(func(objc.Block, objc.ID) { fn() })
	center := mcClass("NSNotificationCenter").Send(mc.selDefaultCenter)
	return center.Send(mc.selAddObserver, name, object, objc.ID(0), b), objc.ID(b)
}

func mcUnobserve(token, block objc.ID) {
	if token == 0 {
		return
	}
	mcClass("NSNotificationCenter").Send(mc.selDefaultCenter).Send(mc.selRemoveObserver, token)
	objc.Block(block).Release()
}

// mcPool opens an autorelease pool on this thread, which Go threads do not have: without it the objects that Foundation
// returns autoreleased are never freed. The returned function closes it.
func mcPool() func() {
	runtime.LockOSThread()
	pool := mc.poolPush()
	return func() {
		mc.poolPop(pool)
		runtime.UnlockOSThread()
	}
}

// mcErrCell is a place for an NSError** out-parameter that is never on a Go stack.
//
//go:noinline
func mcErrCell() *objc.ID { return new(objc.ID) }
