//go:build windows

package native

import (
	"strings"
	"sync"
)

var (
	encodersOnce sync.Once
	encoderList  []BackendInfo
)

// listEncoders asks Media Foundation which hardware H.264 encoder transforms can be made, one entry per graphics vendor
// named after the card, and adds the software encoder last. The answer is kept.
func listEncoders() []BackendInfo {
	encodersOnce.Do(func() {
		done := make(chan struct{})
		go func() {
			defer close(done)
			end, err := comSession()
			if err != nil {
				return
			}
			defer end()
			encoderList = probeEncoders()
		}()
		<-done
	})
	return append([]BackendInfo(nil), encoderList...)
}

// probeEncoders makes each transform once, which is what tells a transform that is listed from one that works (a vendor's
// transform of a card that is not driving the display is listed and fails to start).
func probeEncoders() []BackendInfo {
	var list []BackendInfo
	seen := map[string]bool{}
	cands := hardwareEncoders()
	defer releaseCandidates(cands)
	adapters := winAdapters()
	for _, c := range cands {
		if seen[c.backend] {
			continue
		}
		obj, err := c.activate.activate(&iidIMFTransform)
		if err != nil {
			continue
		}
		obj.release()
		c.activate.shutdownObject()
		seen[c.backend] = true
		list = append(list, BackendInfo{ID: c.backend, Name: encoderName(c, adapters)})
	}
	if obj, err := coCreateInstance(&clsidMSH264EncoderMFT, &iidIMFTransform); err == nil {
		obj.release()
		list = append(list, BackendInfo{ID: Software, Name: "Microsoft H.264 encoder (software)"})
	}
	return list
}

var encoderTech = map[string]string{NVIDIA: "NVENC", AMD: "AMF", Intel: "Quick Sync"}

// encoderName is the card's name with the encoder technology, "NVIDIA GeForce RTX 4070 (NVENC)", or the transform's own
// name when DXGI does not know the card.
func encoderName(c encCandidate, adapters []winAdapter) string {
	for _, a := range adapters {
		if vendorBackend(a.pci) == c.backend && a.name != "" {
			return a.name + " (" + encoderTech[c.backend] + ")"
		}
	}
	return strings.TrimSpace(c.name)
}
