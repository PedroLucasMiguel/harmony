//go:build !windows

package platform

import "unsafe"

func CursorPosition() (x, y int, ok bool)                 { return 0, 0, false }
func SetWindowRect(_ unsafe.Pointer, _, _, _, _ int) bool { return false }
func WorkArea(unsafe.Pointer) (x, y, w, h int, ok bool)   { return 0, 0, 0, 0, false }
func WindowRect(unsafe.Pointer) (x, y, w, h int, ok bool) { return 0, 0, 0, 0, false }
