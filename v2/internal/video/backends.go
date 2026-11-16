package video

import (
	"slices"
	"sync"
	"sync/atomic"

	"harmony/v2/internal/video/native"
)

// Backend is one codec choice this system has: ID is what is saved and passed on, Name is for the person.
type Backend = native.BackendInfo

var backends struct {
	once     sync.Once
	ready    atomic.Bool
	enc, dec []Backend
}

func probe() {
	backends.once.Do(func() {
		backends.enc, backends.dec = native.Encoders(), native.Decoders()
		backends.ready.Store(true)
	})
}

// Encoders lists the H.264 encoders this system has, the best first. The first call waits for the probe; do not make it on the UI thread.
func Encoders() []Backend { probe(); return backends.enc }

// Decoders lists the H.264 decoders this system has, the best first, as Encoders does.
func Decoders() []Backend { probe(); return backends.dec }

// Choice is the backend to ask for from a saved choice: the choice itself, or "" (automatic) when the probe has finished
// and the system no longer has it. It never waits.
func Choice(saved string, list func() []Backend) string {
	if saved == "" || !backends.ready.Load() || slices.ContainsFunc(list(), func(b Backend) bool { return b.ID == saved }) {
		return saved
	}
	return ""
}

// EncoderChoice and DecoderChoice are Choice for the two lists.
func EncoderChoice(saved string) string { return Choice(saved, Encoders) }
func DecoderChoice(saved string) string { return Choice(saved, Decoders) }

// SoftwareBackend is the ID of the system's software codec, which is what "Encode on the GPU" turned off asks for.
const SoftwareBackend = native.Software
