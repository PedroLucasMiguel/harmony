// Package version is the number this build reports in About. A release sets it with
// -ldflags "-X harmony/v2/internal/version.Number=5.2.8" (dev/build.sh does); a plain go build reports "dev" and the commit.
package version

import (
	"runtime"
	"runtime/debug"
)

// Number is set by the linker.
var Number string

// String is the number, or "dev" and the short commit the program was built from.
func String() string {
	if Number != "" {
		return Number
	}
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "dev"
	}
	revision, dirty := "", ""
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			revision = s.Value[:min(len(s.Value), 7)]
		case "vcs.modified":
			if s.Value == "true" {
				dirty = "+"
			}
		}
	}
	if revision == "" {
		return "dev"
	}
	return "dev " + revision + dirty
}

// Report is what to paste into a bug report.
func Report() string {
	return "Harmony v2 " + String() + " (" + runtime.GOOS + "/" + runtime.GOARCH + ")"
}
