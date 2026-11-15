package platform

import (
	"runtime"
	"time"
	"unsafe"

	"github.com/ebitengine/purego/objc"
)

const (
	eventMaskAny        = ^uint(0)
	eventTypeAppDefined = 15
)

var (
	selAlloc     = objc.RegisterName("alloc")
	selInit      = objc.RegisterName("init")
	selDrain     = objc.RegisterName("drain")
	selSharedApp = objc.RegisterName("sharedApplication")
	selNextEvent = objc.RegisterName("nextEventMatchingMask:untilDate:inMode:dequeue:")
	selPostEvent = objc.RegisterName("postEvent:atStart:")
	selNewEvent  = objc.RegisterName("otherEventWithType:location:modifierFlags:timestamp:windowNumber:context:subtype:data1:data2:")
	selNewDate   = objc.RegisterName("dateWithTimeIntervalSinceNow:")
	selFuture    = objc.RegisterName("distantFuture")
	selNewString = objc.RegisterName("stringWithUTF8String:")

	classPool   = objc.GetClass("NSAutoreleasePool")
	classEvent  = objc.GetClass("NSEvent")
	classDate   = objc.GetClass("NSDate")
	classString = objc.GetClass("NSString")
	classApp    = objc.GetClass("NSApplication")
)

func newPool() objc.ID { return objc.ID(classPool).Send(selAlloc).Send(selInit) }

// WaitEvents blocks until the window system has an event for the window or timeout passes (0 waits without end).
// The event stays queued for the next poll.
func WaitEvents(_ unsafe.Pointer, timeout time.Duration) {
	pool := newPool()
	defer pool.Send(selDrain)
	until := objc.ID(classDate).Send(selFuture)
	if timeout > 0 {
		until = objc.ID(classDate).Send(selNewDate, timeout.Seconds())
	}
	mode := objc.ID(classString).Send(selNewString, "kCFRunLoopDefaultMode")
	app := objc.ID(classApp).Send(selSharedApp)
	app.Send(selNextEvent, eventMaskAny, until, mode, false)
}

// WakeEvents makes a WaitEvents in progress, or the next one, return; safe from any goroutine.
func WakeEvents(_ unsafe.Pointer) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	pool := newPool()
	defer pool.Send(selDrain)
	event := objc.ID(classEvent).Send(selNewEvent, uint(eventTypeAppDefined), 0.0, 0.0, uint(0), 0.0, 0, objc.ID(0), 0, 0, 0)
	objc.ID(classApp).Send(selSharedApp).Send(selPostEvent, event, true)
}
