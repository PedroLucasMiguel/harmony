//go:build windows

// The hardware Media Foundation transforms of a category, each with the graphics vendor it belongs to.
package native

import "strconv"

// mftVendor is a hardware transform: its Backend ID ("nvidia", "amd", "intel", or "" for another vendor), the PCI
// vendor ID, its friendly name and the activate that makes it.
type mftVendor struct {
	backend  string
	pci      uint32
	name     string
	activate mfActivate
}

// mftHardware lists the hardware transforms of the category that take the subtype of the video major type as input,
// best first. The caller releases every activate it does not use.
func mftHardware(category, subtype *guid) []mftVendor {
	in := &mftRegisterTypeInfo{major: guidMediaTypeVideo, sub: *subtype}
	acts, err := mftEnumEx(category, mftEnumHardware|mftEnumSortFilter, in, nil)
	if err != nil {
		return nil
	}
	list := make([]mftVendor, 0, len(acts))
	for _, a := range acts {
		v := mftVendor{activate: a}
		if s, ok, _ := a.getString(&mftFriendlyName); ok {
			v.name = s
		}
		if s, ok, _ := a.getString(&mftHardwareVendorID); ok {
			v.pci = parseVendorID(s)
			v.backend = vendorBackend(v.pci)
		}
		list = append(list, v)
	}
	return list
}

// parseVendorID reads the "VEN_10DE" form of MFT_ENUM_HARDWARE_VENDOR_ID_Attribute.
func parseVendorID(s string) uint32 {
	if len(s) >= 4 && s[:4] == "VEN_" {
		s = s[4:]
	}
	v, err := strconv.ParseUint(s, 16, 32)
	if err != nil {
		return 0
	}
	return uint32(v)
}
