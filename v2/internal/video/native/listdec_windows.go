//go:build windows

// The H.264 decoders of this machine: one per graphics vendor that decodes in hardware, and the software decoder.
package native

import "sync"

// winDecoderEntry is what a backend can be opened as: a hardware transform of the vendor, the system decoder on the
// vendor's adapter (DXVA), or both.
type winDecoderEntry struct {
	info BackendInfo
	mft  bool
	dxva bool
}

var decProbe struct {
	once    sync.Once
	entries []winDecoderEntry
}

func decoderEntries() []winDecoderEntry {
	decProbe.once.Do(func() { decProbe.entries = probeDecoders() })
	return decProbe.entries
}

func listDecoders() []BackendInfo {
	entries := decoderEntries()
	list := make([]BackendInfo, len(entries))
	for i, e := range entries {
		list[i] = e.info
	}
	return list
}

func probeDecoders() []winDecoderEntry {
	end, err := comSession()
	if err != nil {
		return nil
	}
	defer end()
	var entries []winDecoderEntry
	find := func(id string) *winDecoderEntry {
		for i := range entries {
			if entries[i].info.ID == id {
				return &entries[i]
			}
		}
		return nil
	}
	for _, a := range winAdapters() {
		id := vendorBackend(a.pci)
		if id == "" || !a.decodes || find(id) != nil {
			continue
		}
		entries = append(entries, winDecoderEntry{info: BackendInfo{ID: id, Name: a.name}, dxva: true})
	}
	for _, v := range mftHardware(&guidCategoryDec, &guidVideoH264) {
		v.activate.release()
		if v.backend == "" {
			continue
		}
		if e := find(v.backend); e != nil {
			e.mft = true
		} else {
			entries = append(entries, winDecoderEntry{info: BackendInfo{ID: v.backend, Name: v.name}, mft: true})
		}
	}
	return append(entries, winDecoderEntry{info: BackendInfo{ID: Software, Name: "Microsoft H.264 decoder (software)"}})
}
