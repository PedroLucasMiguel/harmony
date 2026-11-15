//go:build linux

package native

import (
	"errors"
	"fmt"
)

// newEncoder starts the H.264 encoder the Backend asks for: NVENC for NVIDIA, VA-API for AMD and Intel. With no Backend it
// takes the best one the system has, in the order Encoders() lists them.
func newEncoder(p EncodeParams, onAU func([]byte)) (Encoder, error) {
	switch p.Backend {
	case NVIDIA:
		return newNVEncoder(p, onAU)
	case AMD:
		return newVAEncoder(p, onAU, pciVendorAMD)
	case Intel:
		return newVAEncoder(p, onAU, pciVendorIntel)
	case Auto:
		return newBestEncoder(p, onAU)
	}
	return nil, fmt.Errorf("the encoder %q does not exist on Linux", p.Backend)
}

func newBestEncoder(p EncodeParams, onAU func([]byte)) (Encoder, error) {
	var first error
	for _, b := range listEncoders() {
		p.Backend = b.ID
		e, err := newEncoder(p, onAU)
		if err == nil {
			return e, nil
		}
		first = cmpErr(first, err)
	}
	if first != nil {
		return nil, first
	}
	// Nothing is listed: the attempt is made anyway so that the error says what to install.
	if _, err := newNVEncoder(p, onAU); err != nil && !errors.Is(err, ErrUnsupported) {
		return nil, err
	}
	return newVAEncoder(p, onAU, 0)
}
