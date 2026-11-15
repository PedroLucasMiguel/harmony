package platform

import (
	"unsafe"

	"github.com/ebitengine/purego/objc"
)

const (
	styleFullSizeContentView = 1 << 15
	styleFullScreen          = 1 << 14
	titleHidden              = 1
	buttonCount              = 3
)

type point struct{ X, Y float64 }
type size struct{ W, H float64 }
type rect struct {
	Origin point
	Size   size
}

var (
	selStyleMask    = objc.RegisterName("styleMask")
	selSetStyleMask = objc.RegisterName("setStyleMask:")
	selTransparent  = objc.RegisterName("setTitlebarAppearsTransparent:")
	selTitleVisible = objc.RegisterName("setTitleVisibility:")
	selStdButton    = objc.RegisterName("standardWindowButton:")
	selFrame        = objc.RegisterName("frame")
	selSetOrigin    = objc.RegisterName("setFrameOrigin:")
	selSuperview    = objc.RegisterName("superview")
	selZoom         = objc.RegisterName("zoom:")
	selMiniaturize  = objc.RegisterName("miniaturize:")
	selIsZoomed     = objc.RegisterName("isZoomed")
)

// lights remembers where the system puts the three window buttons, so they can be moved to the same place again after the system lays them out anew.
var lights struct {
	known   bool
	x, step float64
}

// CustomFrame lets the content reach under the title bar, which is made clear and left without its title, so the program draws its own bar beside the window's three buttons.
func CustomFrame(window unsafe.Pointer) {
	if window == nil {
		return
	}
	w := objc.ID(window)
	mask := objc.Send[uint](w, selStyleMask)
	w.Send(selSetStyleMask, mask|styleFullSizeContentView)
	w.Send(selTransparent, true)
	w.Send(selTitleVisible, titleHidden)
}

// PlaceTrafficLights puts the close, minimise and zoom buttons x points from the window's left edge and top points below its top.
func PlaceTrafficLights(window unsafe.Pointer, x, top float64) {
	if window == nil {
		return
	}
	w := objc.ID(window)
	close := w.Send(selStdButton, 0)
	if close == 0 {
		return
	}
	if !lights.known {
		first := objc.Send[rect](close, selFrame)
		second := objc.Send[rect](w.Send(selStdButton, 1), selFrame)
		lights.known, lights.x, lights.step = true, first.Origin.X, second.Origin.X-first.Origin.X
	}
	for i := range buttonCount {
		button := w.Send(selStdButton, i)
		frame := objc.Send[rect](button, selFrame)
		height := objc.Send[rect](button.Send(selSuperview), selFrame).Size.H
		button.Send(selSetOrigin, point{x + float64(i)*lights.step, height - top - frame.Size.H})
	}
}

// IsFullScreen says whether the window covers the whole screen, where the buttons are not there.
func IsFullScreen(window unsafe.Pointer) bool {
	return window != nil && objc.Send[uint](objc.ID(window), selStyleMask)&styleFullScreen != 0
}

// ToggleZoom is what a double press on the title bar does: fill the screen, or go back.
func ToggleZoom(window unsafe.Pointer) { objc.ID(window).Send(selZoom, objc.ID(0)) }

// TrafficLightsRight is how far from the window's left edge the buttons reach.
func TrafficLightsRight(window unsafe.Pointer) float64 {
	zoom := objc.ID(window).Send(selStdButton, 2)
	frame := objc.Send[rect](zoom, selFrame)
	return frame.Origin.X + frame.Size.W
}
