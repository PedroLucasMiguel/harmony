//go:build !darwin && !linux && !windows

package notify

const clickable = false

// Show does nothing on a system with no notifications to talk to.
func Show(Notification) error { return nil }
