package raw

import (
	"unsafe"

	rl "github.com/gen2brain/raylib-go/raylib"

	"github.com/jupiterrider/ffi"
)

var inputs struct {
	isKeyPressed, isKeyPressedRepeat, isKeyDown, getCharPressed    Entry
	isMouseButtonPressed, isMouseButtonDown, isMouseButtonReleased Entry
	isFileDropped                                                  Entry
	getMousePosition, getMouseWheelMove                            *prepared
}

func init() {
	inputs.isKeyPressed = Lookup("IsKeyPressed")
	inputs.isKeyPressedRepeat = Lookup("IsKeyPressedRepeat")
	inputs.isKeyDown = Lookup("IsKeyDown")
	inputs.getCharPressed = Lookup("GetCharPressed")
	inputs.isMouseButtonPressed = Lookup("IsMouseButtonPressed")
	inputs.isMouseButtonDown = Lookup("IsMouseButtonDown")
	inputs.isMouseButtonReleased = Lookup("IsMouseButtonReleased")
	inputs.isFileDropped = Lookup("IsFileDropped")
	inputs.getMousePosition = prepare("GetMousePosition", &typeVec2)
	inputs.getMouseWheelMove = prepare("GetMouseWheelMove", &ffi.TypeFloat)
}

func IsKeyPressed(key int32) bool { return byte(inputs.isKeyPressed.Call(uintptr(key))) != 0 }
func IsKeyPressedRepeat(key int32) bool {
	return byte(inputs.isKeyPressedRepeat.Call(uintptr(key))) != 0
}
func IsKeyDown(key int32) bool { return byte(inputs.isKeyDown.Call(uintptr(key))) != 0 }
func GetCharPressed() int32    { return int32(inputs.getCharPressed.Call()) }
func IsFileDropped() bool      { return byte(inputs.isFileDropped.Call()) != 0 }

func IsMouseButtonPressed(button rl.MouseButton) bool {
	return byte(inputs.isMouseButtonPressed.Call(uintptr(button))) != 0
}

func IsMouseButtonDown(button rl.MouseButton) bool {
	return byte(inputs.isMouseButtonDown.Call(uintptr(button))) != 0
}

func IsMouseButtonReleased(button rl.MouseButton) bool {
	return byte(inputs.isMouseButtonReleased.Call(uintptr(button))) != 0
}

var (
	mouse [2]float32
	wheel float32
)

func GetMousePosition() (x, y float32) {
	inputs.getMousePosition.call(unsafe.Pointer(&mouse))
	return mouse[0], mouse[1]
}

func GetMouseWheelMove() float32 {
	inputs.getMouseWheelMove.call(unsafe.Pointer(&wheel))
	return wheel
}
