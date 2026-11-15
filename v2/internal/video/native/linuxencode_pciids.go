package native

import (
	"fmt"
	"strings"
)

// pciIDsName finds a device in the text of pci.ids and names it the way a person would: the marketing name in square
// brackets when there is one ("DG2 [Arc A380]" is "Arc A380"), with the make in front.
func pciIDsName(db string, vendor, device uint32) string {
	vendorLine := fmt.Sprintf("%04x ", vendor)
	deviceLine := fmt.Sprintf("\t%04x ", device)
	inVendor := false
	for _, line := range strings.Split(db, "\n") {
		if line == "" || line[0] == '#' {
			continue
		}
		if line[0] != '\t' {
			inVendor = strings.HasPrefix(line, vendorLine)
			continue
		}
		if !inVendor || !strings.HasPrefix(line, deviceLine) {
			continue
		}
		name := strings.TrimSpace(line[len(deviceLine):])
		if i, j := strings.IndexByte(name, '['), strings.LastIndexByte(name, ']'); i >= 0 && j > i {
			name = name[i+1 : j]
		}
		vendorName := map[uint32]string{0x1002: "AMD", 0x8086: "Intel"}[vendor]
		if vendorName != "" && !strings.HasPrefix(name, vendorName) {
			name = vendorName + " " + name
		}
		return name
	}
	return ""
}
