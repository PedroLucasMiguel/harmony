package shell

import (
	"os"
	"path/filepath"

	"harmony/v2/internal/instance"
)

// single makes this the one Harmony of the profile, or returns nil when another is running, which has been asked to show itself.
// A run pointed at a server by hand, or one that takes a screenshot, is a developer's and may be one of many.
func single(options Options) *instance.Instance {
	if options.Server != "" || options.Screenshot != "" {
		return &instance.Instance{}
	}
	dir, _ := os.UserConfigDir()
	return instance.Acquire(filepath.Join(dir, "Harmony v2"))
}
