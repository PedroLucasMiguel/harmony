package updater

import (
	"fmt"
	"runtime"
	"strings"
)

// newer is whether a version is above another, numerically by major, minor and patch; a pre-release suffix is ignored.
func newer(candidate, current string) bool {
	a, b := parts(candidate), parts(current)
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return false
}

func parts(version string) [3]int {
	var out [3]int
	fields := strings.FieldsFunc(strings.TrimPrefix(version, "v"), func(r rune) bool { return r == '.' || r == '-' || r == '+' })
	for i := 0; i < len(out) && i < len(fields); i++ {
		_, _ = fmt.Sscanf(fields[i], "%d", &out[i])
	}
	return out
}

// assetName is what a release calls this system's build.
func assetName() string {
	name := "harmony2-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return name
}

// pick is the release's build for this system, or nil when it has none.
func pick(assets []asset) *asset {
	want := assetName()
	for i := range assets {
		if assets[i].Name == want {
			return &assets[i]
		}
	}
	return nil
}

// checksumOf finds the SHA-256 a release states for a file: the asset's own digest, or a line of a checksum file
// ("<hex>  <name>"), which is what `sha256sum` writes.
func checksumOf(a *asset, sums string) string {
	if hex, ok := strings.CutPrefix(a.Digest, "sha256:"); ok && len(hex) == 64 {
		return strings.ToLower(hex)
	}
	for _, line := range strings.Split(sums, "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 && len(f[0]) == 64 && strings.TrimPrefix(f[1], "*") == a.Name {
			return strings.ToLower(f[0])
		}
		if len(f) == 1 && len(f[0]) == 64 {
			return strings.ToLower(f[0])
		}
	}
	return ""
}
