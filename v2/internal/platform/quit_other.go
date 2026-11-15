//go:build !darwin

package platform

// QuitKey is false where the quit key arrives as an ordinary key press.
func QuitKey() bool { return false }
