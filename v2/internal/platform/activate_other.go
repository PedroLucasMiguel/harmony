//go:build !darwin

package platform

// Activate does nothing where the window toolkit's own focus call is enough.
func Activate() {}
