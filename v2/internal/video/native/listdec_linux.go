//go:build linux

package native

import (
	"strings"
	"sync"
)

var (
	decodersOnce sync.Once
	decoders     []BackendInfo
)

// listDecoders probes every render node once: NVIDIA first when it decodes, then the AMD and Intel nodes whose VA-API
// driver has an H.264 decoder.
func listDecoders() []BackendInfo {
	decodersOnce.Do(func() {
		decoders = append(decoders, nvDecoderInfo()...)
		fn, err := loadVA()
		if err != nil {
			return
		}
		seen := map[uint32]bool{}
		var va []BackendInfo
		for _, node := range vaRenderNodes() {
			id := ""
			switch node.Vendor {
			case pciVendorAMD:
				id = AMD
			case pciVendorIntel:
				id = Intel
			default:
				continue
			}
			if seen[node.Vendor] {
				continue
			}
			for _, profile := range []int32{vaProfileH264High, vaProfileH264Main, vaProfileH264ConstrainedBaseline} {
				d, err := openVANode(fn, node, profile, []int32{vaEntrypointVLD})
				if err != nil {
					continue
				}
				seen[node.Vendor] = true
				va = append(va, BackendInfo{ID: id, Name: vaCardName(d.Vendor, node) + " (VA-API)"})
				d.Close()
				break
			}
		}
		for _, wanted := range []string{AMD, Intel} {
			for _, b := range va {
				if b.ID == wanted {
					decoders = append(decoders, b)
				}
			}
		}
	})
	return decoders
}

// vaCardName names the graphics card: Mesa's driver string carries it ("Mesa Gallium driver 24.0 for AMD Radeon RX 6600
// (radeonsi, ...)"), the Intel driver's does not, so sysfs has to do.
func vaCardName(vendorString string, node vaRenderNode) string {
	if _, rest, ok := strings.Cut(vendorString, " for "); ok && strings.Contains(vendorString, "Mesa") {
		if name, _, ok := strings.Cut(rest, " ("); ok && name != "" {
			return name
		}
		return rest
	}
	return node.deviceName()
}
