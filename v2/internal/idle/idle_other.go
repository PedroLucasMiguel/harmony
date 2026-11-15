//go:build !darwin && !windows && !linux

package idle

import "time"

// Since is the time since the last key or mouse event; ok is false when this system cannot say.
func Since() (time.Duration, bool) { return 0, false }
