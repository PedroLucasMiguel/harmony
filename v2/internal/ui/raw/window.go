package raw

import (
	"image/color"
	"unsafe"

	"github.com/jupiterrider/ffi"
)

var window struct {
	beginDrawing, endDrawing, setMouseCursor                         Entry
	getScreenWidth, getScreenHeight, getRenderWidth, getRenderHeight Entry
	isWindowFocused, isWindowMinimized, windowShouldClose            Entry
	clearBackground                                                  *prepared
}

func init() {
	window.beginDrawing = Lookup("BeginDrawing")
	window.endDrawing = Lookup("EndDrawing")
	window.setMouseCursor = Lookup("SetMouseCursor")
	window.getScreenWidth = Lookup("GetScreenWidth")
	window.getScreenHeight = Lookup("GetScreenHeight")
	window.getRenderWidth = Lookup("GetRenderWidth")
	window.getRenderHeight = Lookup("GetRenderHeight")
	window.windowShouldClose = Lookup("WindowShouldClose")
	window.isWindowFocused = Lookup("IsWindowFocused")
	window.isWindowMinimized = Lookup("IsWindowMinimized")
	window.clearBackground = prepare("ClearBackground", &ffi.TypeVoid, &typeRGBA)
}

func BeginDrawing()               { window.beginDrawing.Call() }
func EndDrawing()                 { window.endDrawing.Call() }
func SetMouseCursor(cursor int32) { window.setMouseCursor.Call(uintptr(cursor)) }
func GetScreenWidth() int         { return int(int32(window.getScreenWidth.Call())) }
func GetScreenHeight() int        { return int(int32(window.getScreenHeight.Call())) }
func GetRenderWidth() int         { return int(int32(window.getRenderWidth.Call())) }
func GetRenderHeight() int        { return int(int32(window.getRenderHeight.Call())) }
func WindowShouldClose() bool     { return byte(window.windowShouldClose.Call()) != 0 }
func IsWindowFocused() bool       { return byte(window.isWindowFocused.Call()) != 0 }
func IsWindowMinimized() bool     { return byte(window.isWindowMinimized.Call()) != 0 }

var clearColour color.RGBA

func ClearBackground(c color.RGBA) {
	clearColour = c
	window.clearBackground.call(nil, unsafe.Pointer(&clearColour))
}
