package platform

import (
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

const (
	pfaDepthSize   = 12
	pfaStencilSize = 13
	pfaMaxLen      = 40
)

// attributes without a value; every other attribute is followed by its value
var pfaFlags = map[uint32]bool{1: true, 5: true, 6: true, 51: true, 52: true, 53: true, 54: true, 72: true, 73: true, 74: true,
	75: true, 76: true, 78: true, 80: true, 81: true, 83: true, 90: true, 91: true, 96: true, 97: true}

// NoDepthBuffer makes the window created next have no depth and stencil buffers, which a 2D interface never uses and
// which cost about 19 MB at retina size. GLFW offers no way to ask for that, so the pixel format it asks the system for
// is changed on the way. Call it before the window exists.
func NoDepthBuffer() {
	lib, err := purego.Dlopen("/usr/lib/libobjc.A.dylib", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return
	}
	var instanceMethod func(class objc.Class, sel objc.SEL) uintptr
	var implementation func(method uintptr) uintptr
	var setImplementation func(method, imp uintptr) uintptr
	purego.RegisterLibFunc(&instanceMethod, lib, "class_getInstanceMethod")
	purego.RegisterLibFunc(&implementation, lib, "method_getImplementation")
	purego.RegisterLibFunc(&setImplementation, lib, "method_setImplementation")

	method := instanceMethod(objc.GetClass("NSOpenGLPixelFormat"), objc.RegisterName("initWithAttributes:"))
	if method == 0 {
		return
	}
	original := implementation(method)
	setImplementation(method, purego.NewCallback(func(self, sel uintptr, attributes *uint32) uintptr {
		list := unsafe.Slice(attributes, pfaMaxLen)
		for i := 0; i < pfaMaxLen-1 && list[i] != 0; i++ {
			switch {
			case pfaFlags[list[i]]:
			case list[i] == pfaDepthSize || list[i] == pfaStencilSize:
				list[i+1] = 0
				i++
			default:
				i++
			}
		}
		result, _, _ := purego.SyscallN(original, self, sel, uintptr(unsafe.Pointer(attributes)))
		return result
	}))
}
