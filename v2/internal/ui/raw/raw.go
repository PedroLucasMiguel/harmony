// Package raw calls raylib without boxing arguments. raylib's own binding allocates several objects per call, which adds up
// to hundreds per frame; here integer arguments go through a reused buffer and the few calls with floats or structs
// go through a prepared libffi call with static storage. It must only be used from the interface's thread.
package raw

import (
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/jupiterrider/ffi"

	_ "github.com/gen2brain/raylib-go/raylib"
)

//go:linkname raylibLib github.com/gen2brain/raylib-go/raylib.dll
var raylibLib ffi.Lib

//go:linkname ffiCall github.com/jupiterrider/ffi.call
var ffiCall uintptr

// Entry is a raylib function that takes and returns integers (or pointers, or small structs passed as integers).
type Entry uintptr

func Lookup(name string) Entry {
	addr, err := raylibLib.Get(name)
	if err != nil {
		panic("raylib: " + name + ": " + err.Error())
	}
	return Entry(addr)
}

var args [8]uintptr

func (e Entry) Call(a ...uintptr) uintptr {
	n := copy(args[:], a)
	r, _, _ := purego.SyscallN(uintptr(e), args[:n]...)
	return r
}

func Ptr[T any](p *T) uintptr { return uintptr(unsafe.Pointer(p)) }

var kept [][]byte

// CString is a NUL-terminated copy of s that is never freed, for names looked up once.
func CString(s string) uintptr {
	b := append([]byte(s), 0)
	kept = append(kept, b)
	return uintptr(unsafe.Pointer(&b[0]))
}

// A prepared call for functions that return floats or structs, or take a struct that is not an integer in a register.
type prepared struct {
	addr uintptr
	cif  ffi.Cif
}

var (
	pointers [4]unsafe.Pointer
	typeVec2 = ffi.NewType(&ffi.TypeFloat, &ffi.TypeFloat)
	typeRGBA = ffi.NewType(&ffi.TypeUint8, &ffi.TypeUint8, &ffi.TypeUint8, &ffi.TypeUint8)
)

func prepare(name string, ret *ffi.Type, arguments ...*ffi.Type) *prepared {
	p := &prepared{addr: uintptr(Lookup(name))}
	if status := ffi.PrepCif(&p.cif, ffi.DefaultAbi, uint32(len(arguments)), ret, arguments...); status != ffi.OK {
		panic("raylib: " + name + ": " + status.String())
	}
	return p
}

// call is ffi.Call with its arguments in the reused buffers, since ffi.Call allocates its argument list.
func (p *prepared) call(ret unsafe.Pointer, a ...unsafe.Pointer) {
	copy(pointers[:], a)
	args[0], args[1], args[2], args[3] = uintptr(unsafe.Pointer(&p.cif)), p.addr, uintptr(ret), uintptr(unsafe.Pointer(&pointers[0]))
	purego.SyscallN(ffiCall, args[:4]...)
}
