//go:build linux

package native

// A PipeWire video stream read through libpipewire-0.3, loaded at run time: the connection is the file descriptor the screen
// cast portal hands over, the stream asks for 4-byte RGB pictures in plain memory (no GPU buffers, so no format modifier is
// offered), and each picture is scaled into the capture sink from the loop's own thread.

import (
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
)

const pipewireInstall = "install PipeWire (Debian/Ubuntu: libpipewire-0.3-0; Fedora: pipewire-libs; Arch: pipewire)"

const (
	pwDirectionInput     = 0
	pwStreamAutoconnect  = 1 << 0
	pwStreamMapBuffers   = 1 << 2
	pwStreamError        = -1
	pwStreamUnconnected  = 0
	pwNegotiationTimeout = 15 * time.Second
	spaDataMemPtr        = 1
	spaDataMemFd         = 2
)

type pwFuncs struct {
	init            func(argc, argv uintptr)
	mainLoopNew     func(props uintptr) uintptr
	mainLoopGetLoop func(l uintptr) uintptr
	mainLoopRun     func(l uintptr) int32
	mainLoopQuit    func(l uintptr) int32
	mainLoopDestroy func(l uintptr)
	contextNew      func(loop, props, size uintptr) uintptr
	contextConnecFd func(ctx uintptr, fd int32, props, size uintptr) uintptr
	contextDestroy  func(ctx uintptr)
	coreDisconnect  func(core uintptr) int32
	propsNewString  func(s string) uintptr
	streamNew       func(core uintptr, name string, props uintptr) uintptr
	streamAddListen func(stream, hook, events, data uintptr)
	streamConnect   func(stream uintptr, dir int32, target, flags uint32, params uintptr, n uint32) int32
	streamDequeue   func(stream uintptr) uintptr
	streamQueue     func(stream, buf uintptr) int32
	streamDisconn   func(stream uintptr) int32
	streamDestroy   func(stream uintptr)

	cbState, cbParam, cbProcess uintptr
}

var (
	pwOnce   sync.Once
	pwLib    pwFuncs
	pwErr    error
	pwMu     sync.Mutex
	pwNext   uintptr
	pwActive = map[uintptr]*pwStream{}
)

// loadPipeWire loads the library and makes the three callbacks once: callbacks are never freed by purego, so they find
// their stream by the data word PipeWire hands back.
func loadPipeWire() (*pwFuncs, error) {
	pwOnce.Do(func() {
		lib, err := purego.Dlopen("libpipewire-0.3.so.0", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			pwErr = fmt.Errorf("PipeWire is not available (%v): %s", err, pipewireInstall)
			return
		}
		var missing string
		reg := func(fptr any, name string) {
			if _, err := purego.Dlsym(lib, name); err != nil {
				missing = name
				return
			}
			purego.RegisterLibFunc(fptr, lib, name)
		}
		f := &pwLib
		reg(&f.init, "pw_init")
		reg(&f.mainLoopNew, "pw_main_loop_new")
		reg(&f.mainLoopGetLoop, "pw_main_loop_get_loop")
		reg(&f.mainLoopRun, "pw_main_loop_run")
		reg(&f.mainLoopQuit, "pw_main_loop_quit")
		reg(&f.mainLoopDestroy, "pw_main_loop_destroy")
		reg(&f.contextNew, "pw_context_new")
		reg(&f.contextConnecFd, "pw_context_connect_fd")
		reg(&f.contextDestroy, "pw_context_destroy")
		reg(&f.coreDisconnect, "pw_core_disconnect")
		reg(&f.propsNewString, "pw_properties_new_string")
		reg(&f.streamNew, "pw_stream_new")
		reg(&f.streamAddListen, "pw_stream_add_listener")
		reg(&f.streamConnect, "pw_stream_connect")
		reg(&f.streamDequeue, "pw_stream_dequeue_buffer")
		reg(&f.streamQueue, "pw_stream_queue_buffer")
		reg(&f.streamDisconn, "pw_stream_disconnect")
		reg(&f.streamDestroy, "pw_stream_destroy")
		if missing != "" {
			pwErr = fmt.Errorf("libpipewire is too old (no %s): %s", missing, pipewireInstall)
			return
		}
		f.cbState = purego.NewCallback(func(data uintptr, old, state int32, errStr uintptr) {
			if s := pwLookup(data); s != nil {
				s.stateChanged(state, errStr)
			}
		})
		f.cbParam = purego.NewCallback(func(data uintptr, id uint32, param uintptr) {
			if s := pwLookup(data); s != nil {
				s.paramChanged(id, param)
			}
		})
		f.cbProcess = purego.NewCallback(func(data uintptr) {
			if s := pwLookup(data); s != nil {
				s.process()
			}
		})
	})
	if pwErr != nil {
		return nil, pwErr
	}
	return &pwLib, nil
}

func pwLookup(id uintptr) *pwStream {
	pwMu.Lock()
	defer pwMu.Unlock()
	return pwActive[id]
}

// addr turns an address that C handed over into a pointer; go vet cannot see that it is not Go memory.
func addr(a uintptr) unsafe.Pointer { return *(*unsafe.Pointer)(unsafe.Pointer(&a)) }

// goCString reads a C string of at most 256 bytes.
func goCString(a uintptr) string {
	var b []byte
	for i := uintptr(0); i < 256; i++ {
		c := *(*byte)(addr(a + i))
		if c == 0 {
			break
		}
		b = append(b, c)
	}
	return string(b)
}

type pwFormat struct {
	format uint32
	w, h   int
}

type pwStream struct {
	fn     *pwFuncs
	id     uintptr
	fd     int
	fps    int
	nodeID uint32

	loop, core, ctx, stream uintptr
	hook                    [64]byte
	events                  [11]uintptr
	params                  []byte
	paramPtr                [1]uintptr

	setup    chan error
	negotiat chan pwFormat
	done     chan struct{}
	onEnd    func(error)
	quitting atomic.Bool

	fmtMu     sync.Mutex
	cur       pwFormat
	sink      atomic.Pointer[captureSink]
	scaler    *capScaler
	scalerFor [4]int
	swapRB    bool
	empty     int
}

// startPipeWire connects to the node over the descriptor (which it takes over) and waits for the picture format.
func startPipeWire(fd int, node uint32, fps int, onEnd func(error)) (*pwStream, pwFormat, error) {
	fn, err := loadPipeWire()
	if err != nil {
		return nil, pwFormat{}, err
	}
	s := &pwStream{fn: fn, fd: fd, fps: fps, nodeID: node, onEnd: onEnd,
		setup: make(chan error, 1), negotiat: make(chan pwFormat, 4), done: make(chan struct{})}
	pwMu.Lock()
	pwNext++
	s.id = pwNext
	pwActive[s.id] = s
	pwMu.Unlock()
	go s.run()
	if err := <-s.setup; err != nil {
		<-s.done
		return nil, pwFormat{}, err
	}
	select {
	case f := <-s.negotiat:
		return s, f, nil
	case <-time.After(pwNegotiationTimeout):
		s.Close()
		return nil, pwFormat{}, fmt.Errorf("the screen did not start sending pictures within %v", pwNegotiationTimeout)
	case <-s.done:
		return nil, pwFormat{}, fmt.Errorf("PipeWire closed the screen stream")
	}
}

// run owns the loop's thread: everything of PipeWire's is created, run and destroyed here.
func (s *pwStream) run() {
	runtime.LockOSThread()
	defer close(s.done)
	defer func() {
		pwMu.Lock()
		delete(pwActive, s.id)
		pwMu.Unlock()
	}()
	fn := s.fn
	fn.init(0, 0)
	s.loop = fn.mainLoopNew(0)
	if s.loop == 0 {
		s.setup <- fmt.Errorf("PipeWire's main loop could not be created")
		return
	}
	defer fn.mainLoopDestroy(s.loop)
	s.ctx = fn.contextNew(fn.mainLoopGetLoop(s.loop), 0, 0)
	if s.ctx == 0 {
		s.setup <- fmt.Errorf("PipeWire's context could not be created")
		return
	}
	defer fn.contextDestroy(s.ctx)
	s.core = fn.contextConnecFd(s.ctx, int32(s.fd), 0, 0)
	if s.core == 0 {
		syscall.Close(s.fd)
		s.setup <- fmt.Errorf("PipeWire did not accept the connection of the screen cast portal")
		return
	}
	defer fn.coreDisconnect(s.core)
	s.stream = fn.streamNew(s.core, "harmony-screen", fn.propsNewString("media.type=Video media.category=Capture media.role=Screen"))
	if s.stream == 0 {
		s.setup <- fmt.Errorf("PipeWire's stream could not be created")
		return
	}
	defer fn.streamDestroy(s.stream)
	// pw_stream_events: version 0, then destroy, state_changed, control_info, io_changed, param_changed, add_buffer,
	// remove_buffer, process, drained, command.
	s.events[2], s.events[5], s.events[8] = fn.cbState, fn.cbParam, fn.cbProcess
	fn.streamAddListen(s.stream, uintptr(unsafe.Pointer(&s.hook[0])), uintptr(unsafe.Pointer(&s.events[0])), s.id)
	s.params = enumVideoFormat(s.fps)
	s.paramPtr[0] = uintptr(unsafe.Pointer(&s.params[0]))
	res := fn.streamConnect(s.stream, pwDirectionInput, s.nodeID, pwStreamAutoconnect|pwStreamMapBuffers, uintptr(unsafe.Pointer(&s.paramPtr[0])), 1)
	if res < 0 {
		s.setup <- fmt.Errorf("PipeWire cannot connect to the screen (error %d)", res)
		return
	}
	s.setup <- nil
	fn.mainLoopRun(s.loop)
	fn.streamDisconn(s.stream)
	runtime.KeepAlive(s)
}

func (s *pwStream) stateChanged(state int32, errStr uintptr) {
	if state != pwStreamError && state != pwStreamUnconnected || s.quitting.Load() {
		return
	}
	msg := "the screen share ended"
	if state == pwStreamError && errStr != 0 {
		msg = "the screen share failed: " + goCString(errStr)
	}
	s.finish(fmt.Errorf("%s", msg))
}

// finish ends the capture from inside the loop: the loop stops and the owner is told once.
func (s *pwStream) finish(err error) {
	if s.quitting.Swap(true) {
		return
	}
	s.fn.mainLoopQuit(s.loop)
	go s.onEnd(err)
}

func (s *pwStream) paramChanged(id uint32, param uintptr) {
	if id != spaParamFormat || param == 0 {
		return
	}
	size := 8 + int(*(*uint32)(addr(param)))
	if size > 4096 {
		return
	}
	f, w, h, ok := videoFormat(unsafe.Slice((*byte)(addr(param)), size))
	if !ok {
		return
	}
	s.fmtMu.Lock()
	s.cur = pwFormat{f, w, h}
	s.fmtMu.Unlock()
	select {
	case s.negotiat <- pwFormat{f, w, h}:
	default:
	}
}

// process takes the newest picture, scales it into the sink's buffer and gives the PipeWire buffer back.
func (s *pwStream) process() {
	fn := s.fn
	buf := fn.streamDequeue(s.stream)
	if buf == 0 {
		return
	}
	defer fn.streamQueue(s.stream, buf)
	sink := s.sink.Load()
	if sink == nil {
		return
	}
	sb := *(*uintptr)(addr(buf))
	if *(*uint32)(addr(sb + 4)) == 0 {
		return
	}
	data := *(*uintptr)(addr(sb + 16))
	typ, base, chunk := *(*uint32)(addr(data)), *(*uintptr)(addr(data + 24)), *(*uintptr)(addr(data + 32))
	if base == 0 || chunk == 0 || typ != spaDataMemPtr && typ != spaDataMemFd {
		return
	}
	offset, size, stride, flags := *(*uint32)(addr(chunk)), *(*uint32)(addr(chunk + 4)), *(*int32)(addr(chunk + 8)), *(*int32)(addr(chunk + 12))
	s.fmtMu.Lock()
	f := s.cur
	s.fmtMu.Unlock()
	if size == 0 || flags&1 != 0 || !knownVideoFormat(f.format) {
		return
	}
	if stride <= 0 {
		stride = int32(f.w * 4)
	}
	need := int(stride)*(f.h-1) + f.w*4
	if int(size) < need && int(size) < int(stride)*f.h {
		return
	}
	src := unsafe.Slice((*byte)(addr(base+uintptr(offset))), need)
	dst := sink.begin(frameBGRA)
	if dst == nil {
		return
	}
	if dims := [4]int{f.w, f.h, sink.w, sink.h}; dims != s.scalerFor {
		s.scalerFor = dims
		s.scaler = newCapScaler(f.w, f.h, sink.w, sink.h, 4)
	}
	s.scaler.scale(dst, sink.w*4, src, int(stride))
	if rgbOrder(f.format) {
		for i := 0; i+3 < len(dst); i += 4 {
			dst[i], dst[i+2] = dst[i+2], dst[i]
		}
	}
	sink.commit()
}

// Close stops the loop and waits for everything of PipeWire's to be torn down.
func (s *pwStream) Close() {
	if !s.quitting.Swap(true) {
		s.fn.mainLoopQuit(s.loop)
	}
	<-s.done
}
