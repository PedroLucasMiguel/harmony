// Package platform holds the few calls that need the operating system's own APIs.
package platform

import (
	"unsafe"

	"github.com/ebitengine/purego/objc"
)

func UseSRGB(window unsafe.Pointer) {
	if window == nil {
		return
	}
	space := objc.ID(objc.GetClass("NSColorSpace")).Send(objc.RegisterName("sRGBColorSpace"))
	objc.ID(window).Send(objc.RegisterName("setColorSpace:"), space)
}
