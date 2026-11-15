//go:build darwin

package native

import "syscall"

func listEncoders() []BackendInfo {
	if mxLoad() != nil {
		return nil
	}
	name := "Apple VideoToolbox"
	if chip, err := syscall.Sysctl("machdep.cpu.brand_string"); err == nil && chip != "" {
		name += " (" + chip + ")"
	}
	return []BackendInfo{{ID: VideoToolbox, Name: name}, {ID: Software, Name: "Apple VideoToolbox (software)"}}
}
