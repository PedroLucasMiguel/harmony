//go:build darwin

package native

import (
	"strings"
	"syscall"
)

// listDecoders names the VideoToolbox decoder after the chip. Apple's software decoder is not offered: it mis-decodes High
// profile streams that use the 8x8 transform, which is what Electron and this client send.
func listDecoders() []BackendInfo {
	name := "Apple VideoToolbox"
	if chip, err := syscall.Sysctl("machdep.cpu.brand_string"); err == nil {
		if chip = strings.TrimSpace(chip); chip != "" {
			name += " (" + chip + ")"
		}
	}
	return []BackendInfo{{VideoToolbox, name}}
}
