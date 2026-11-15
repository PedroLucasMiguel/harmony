//go:build linux

package native

import (
	"os"
	"strconv"
	"strings"
	"sync"
)

var (
	encodersOnce sync.Once
	encoders     []BackendInfo
)

// listEncoders probes once: NVENC, then the VA-API render nodes of AMD and of Intel that have an H.264 encoder.
func listEncoders() []BackendInfo {
	encodersOnce.Do(func() {
		encoders = append(encoders, nvEncoderInfo()...)
		for _, v := range []struct {
			id     string
			vendor uint32
		}{{AMD, pciVendorAMD}, {Intel, pciVendorIntel}} {
			if info, ok := probeVAEncoder(v.id, v.vendor); ok {
				encoders = append(encoders, info)
			}
		}
	})
	return encoders
}

func probeVAEncoder(id string, vendor uint32) (BackendInfo, bool) {
	for _, c := range vaEncChoices {
		d, err := openVADisplay(vendor, c.profile, vaEntrypointEncSlice, vaEntrypointEncSliceLP)
		if err != nil {
			continue
		}
		name := pciDeviceName(d.Node)
		d.Close()
		return BackendInfo{ID: id, Name: name + " (VA-API)"}, true
	}
	return BackendInfo{}, false
}

// pciDeviceName is the card's name from the PCI database the system ships, "Intel Arc A380"; the generic name of the
// make when the database has not got the device.
func pciDeviceName(n vaRenderNode) string {
	base := "/sys/class/drm/" + baseName(n.Path) + "/device/"
	if dev, err := os.ReadFile(base + "device"); err == nil {
		id, _ := strconv.ParseUint(strings.TrimSpace(string(dev)), 0, 32)
		for _, f := range []string{"/usr/share/hwdata/pci.ids", "/usr/share/misc/pci.ids", "/usr/share/pci.ids"} {
			if data, err := os.ReadFile(f); err == nil {
				if name := pciIDsName(string(data), n.Vendor, uint32(id)); name != "" {
					return name
				}
			}
		}
	}
	return n.deviceName()
}

func baseName(p string) string {
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[i+1:]
	}
	return p
}
