//go:build !darwin

package platform

import "unsafe"

func CustomFrame(unsafe.Pointer)                        {}
func PlaceTrafficLights(_ unsafe.Pointer, _, _ float64) {}
func IsFullScreen(unsafe.Pointer) bool                  { return false }
func ToggleZoom(unsafe.Pointer)                         {}
func TrafficLightsRight(unsafe.Pointer) float64         { return 0 }
