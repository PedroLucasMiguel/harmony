//go:build windows

// The events of an asynchronous hardware transform: a Go object that is an IMFAsyncCallback. Media Foundation calls Invoke
// on its own thread when an event is ready; the event type is handed to the decoder goroutine through a channel.
package native

import (
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"
)

// winEvents is laid out as a COM object: the first word is the address of the method table.
type winEvents struct {
	vtbl   uintptr
	gen    mfEventGenerator
	ch     chan uint32
	closed atomic.Bool
}

var winEventsTable struct {
	once sync.Once
	vtbl [5]uintptr // QueryInterface, AddRef, Release, GetParameters, Invoke
	keep []*winEvents
	mu   sync.Mutex
}

// newWinEvents makes the callback for a transform's event generator. The object stays referenced for the life of the
// process: Media Foundation may call it once more while the transform is being released, and it holds no more than a
// channel.
func newWinEvents(gen mfEventGenerator) *winEvents {
	t := &winEventsTable
	t.once.Do(func() {
		t.vtbl[0] = syscall.NewCallback(winEventsQueryInterface)
		t.vtbl[1] = syscall.NewCallback(func(this uintptr) uintptr { return 2 })
		t.vtbl[2] = syscall.NewCallback(func(this uintptr) uintptr { return 1 })
		t.vtbl[3] = syscall.NewCallback(func(this, flags, queue uintptr) uintptr { return 0x80004001 }) // E_NOTIMPL: default behaviour
		t.vtbl[4] = syscall.NewCallback(winEventsInvoke)
	})
	e := &winEvents{vtbl: uintptr(unsafe.Pointer(&t.vtbl)), gen: gen, ch: make(chan uint32, 64)}
	t.mu.Lock()
	t.keep = append(t.keep, e)
	t.mu.Unlock()
	return e
}

func (e *winEvents) start() hresult { return e.gen.beginGetEvent(uintptr(unsafe.Pointer(e))) }

func winEventsQueryInterface(this, riid, ppv uintptr) uintptr {
	g := (*guid)(at(riid))
	if *g == iidIUnknown || *g == iidIMFAsyncCallback {
		*(*uintptr)(at(ppv)) = this
		return 0
	}
	*(*uintptr)(at(ppv)) = 0
	return 0x80004002 // E_NOINTERFACE
}

func winEventsInvoke(this, result uintptr) uintptr {
	e := (*winEvents)(at(this))
	if e.closed.Load() {
		return 0
	}
	ev, hr := e.gen.endGetEvent(result)
	if hr.failed() {
		return 0
	}
	t := ev.eventType()
	ev.release()
	select {
	case e.ch <- t:
	default:
	}
	if !e.closed.Load() {
		e.gen.beginGetEvent(this)
	}
	return 0
}
