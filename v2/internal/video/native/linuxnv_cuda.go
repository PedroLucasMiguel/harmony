//go:build linux

// What NVENC and NVDEC share on Linux: the driver's own libraries opened with dlopen, one CUDA context for the process, and
// the probe that says whether the graphics card can encode and decode H.264. The libraries are the NVIDIA driver's
// (libcuda.so.1, libnvidia-encode.so.1, libnvcuvid.so.1); without the driver nothing here loads.
package native

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	nvCudaLib   = "libcuda.so.1"
	nvEncodeLib = "libnvidia-encode.so.1"
	nvCuvidLib  = "libnvcuvid.so.1"

	// cuCtxSchedBlockingSync is CU_CTX_SCHED_BLOCKING_SYNC: a thread waiting for the card sleeps instead of spinning.
	cuCtxSchedBlockingSync = 4
	cuMemoryHost           = 1
	cuMemoryDevice         = 2
	cuErrorNoDevice        = 100
)

// nvCall calls a C function with integer and pointer arguments and returns the integer it gives back. A pointer is passed as
// uintptr(unsafe.Pointer(p)) written in the argument list itself: uintptrescapes keeps what it points to on the heap.
//
//go:uintptrescapes
func nvCall(fn uintptr, args ...uintptr) uintptr {
	r, _, _ := purego.SyscallN(fn, args...)
	return r
}

// nvResult is the 32 bit status a CUDA, NVENC or NVDEC function returns in the low half of its result register.
func nvResult(r uintptr) uint32 { return uint32(r) }

// nvAt views the C memory at addr as a T; addr is something the driver handed out.
func nvAt[T any](addr uintptr) *T { return (*T)(*(*unsafe.Pointer)(unsafe.Pointer(&addr))) }

// nvCString reads the NUL ended string at addr.
func nvCString(addr uintptr) string {
	if addr == 0 {
		return ""
	}
	p := nvAt[byte](addr)
	var out []byte
	for i := 0; i < 512; i++ {
		c := *(*byte)(unsafe.Add(unsafe.Pointer(p), i))
		if c == 0 {
			break
		}
		out = append(out, c)
	}
	return string(out)
}

func nvOpenLibrary(name, hint string) (uintptr, error) {
	h, err := purego.Dlopen(name, purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		return 0, fmt.Errorf("%s cannot be loaded (%s): %w", name, hint, err)
	}
	return h, nil
}

// nvSymbols looks the names up in the library, in order; a name that is missing is an error naming it.
func nvSymbols(lib uintptr, libName string, names ...string) ([]uintptr, error) {
	out := make([]uintptr, len(names))
	for i, n := range names {
		p, err := purego.Dlsym(lib, n)
		if err != nil || p == 0 {
			return nil, fmt.Errorf("%s has no %s: the driver is too old or is not the NVIDIA one", libName, n)
		}
		out[i] = p
	}
	return out, nil
}

// nvSystem is the result of looking at the machine once: the CUDA context everything runs in and, for each job, either what
// it needs or the plain reason it cannot be done.
type nvSystem struct {
	gpu string
	ctx uintptr

	cuMemcpy2D, cuCtxPush, cuCtxPop, cuErrorString uintptr

	enc    nvEncAPI
	encErr error
	dec    nvDecAPI
	decErr error
}

var (
	nvOnce   sync.Once
	nvShared nvSystem
)

// nvProbe looks at the machine on first use and remembers what it found.
func nvProbe() *nvSystem {
	nvOnce.Do(func() {
		if err := nvShared.openCUDA(); err != nil {
			nvShared.encErr, nvShared.decErr = err, err
			return
		}
		nvShared.encErr = nvShared.probeEncode()
		nvShared.decErr = nvShared.probeDecode()
	})
	return &nvShared
}

func (s *nvSystem) openCUDA() error {
	lib, err := nvOpenLibrary(nvCudaLib, "the NVIDIA driver is not installed")
	if err != nil {
		return err
	}
	f, err := nvSymbols(lib, nvCudaLib, "cuInit", "cuDeviceGetCount", "cuDeviceGet", "cuDeviceGetName", "cuCtxCreate_v2",
		"cuCtxPushCurrent_v2", "cuCtxPopCurrent_v2", "cuMemcpy2D_v2", "cuGetErrorString")
	if err != nil {
		return err
	}
	cuInit, cuCount, cuGet, cuName, cuCreate := f[0], f[1], f[2], f[3], f[4]
	s.cuCtxPush, s.cuCtxPop, s.cuMemcpy2D, s.cuErrorString = f[5], f[6], f[7], f[8]

	if st := nvResult(nvCall(cuInit, 0)); st != 0 {
		if st == cuErrorNoDevice {
			return errors.New("no NVIDIA graphics card is available to CUDA (cuInit found no device)")
		}
		return s.cuError("cuInit", st)
	}
	var count, dev int32
	if st := nvResult(nvCall(cuCount, uintptr(unsafe.Pointer(&count)))); st != 0 {
		return s.cuError("cuDeviceGetCount", st)
	}
	if count < 1 {
		return errors.New("no CUDA device: the NVIDIA driver sees no graphics card")
	}
	if st := nvResult(nvCall(cuGet, uintptr(unsafe.Pointer(&dev)), 0)); st != 0 {
		return s.cuError("cuDeviceGet", st)
	}
	name := make([]byte, 256)
	if st := nvResult(nvCall(cuName, uintptr(unsafe.Pointer(&name[0])), uintptr(len(name)), uintptr(dev))); st != 0 {
		return s.cuError("cuDeviceGetName", st)
	}
	s.gpu = nvCString(uintptr(unsafe.Pointer(&name[0])))
	// cuCtxCreate leaves the context current on the thread that made it; every user pushes it for as long as it needs it.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if st := nvResult(nvCall(cuCreate, uintptr(unsafe.Pointer(&s.ctx)), cuCtxSchedBlockingSync, uintptr(dev))); st != 0 {
		return s.cuError("cuCtxCreate", st)
	}
	nvCall(s.cuCtxPop, 0)
	return nil
}

// cuError says what a CUDA call that failed means, in the driver's own words.
func (s *nvSystem) cuError(op string, status uint32) error {
	var msg uintptr
	if s.cuErrorString != 0 && nvResult(nvCall(s.cuErrorString, uintptr(status), uintptr(unsafe.Pointer(&msg)))) == 0 {
		return fmt.Errorf("%s failed: %s (CUDA error %d)", op, nvCString(msg), status)
	}
	return fmt.Errorf("%s failed (CUDA error %d)", op, status)
}

// push makes the context current on this thread, which stays locked to the goroutine until pop.
func (s *nvSystem) push() error {
	runtime.LockOSThread()
	if st := nvResult(nvCall(s.cuCtxPush, s.ctx)); st != 0 {
		runtime.UnlockOSThread()
		return s.cuError("cuCtxPushCurrent", st)
	}
	return nil
}

func (s *nvSystem) pop() {
	nvCall(s.cuCtxPop, 0)
	runtime.UnlockOSThread()
}
