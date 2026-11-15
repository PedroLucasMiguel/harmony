//go:build !darwin

package platform

import "unsafe"

func UseSRGB(unsafe.Pointer) {}
