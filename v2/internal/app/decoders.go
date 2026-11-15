package app

import (
	"harmony/v2/internal/video"
)

// SetVideoDecoder chooses the codec backend streams are decoded with ("" is automatic, otherwise an ID from
// video.Decoders()). Streams being watched move to it at once.
func (s *Session) SetVideoDecoder(id string) {
	if old := s.decoderID.Swap(&id); old != nil && *old == id {
		return
	}
	s.decoderFell.Store(false)
	vs := &s.viewers
	vs.mu.Lock()
	running := make([]*viewer, 0, len(vs.list))
	for _, v := range vs.list {
		running = append(running, v)
	}
	vs.mu.Unlock()
	for _, v := range running {
		v.redecode()
	}
}

// newDecoder starts a decoder on the chosen backend; one that cannot start is given up once, in the log, for the
// automatic choice.
func (s *Session) newDecoder(w, h int, colour video.Colour, frame *video.Frame) (*video.Decoder, error) {
	backend := ""
	if id := s.decoderID.Load(); id != nil {
		backend = video.DecoderChoice(*id)
	}
	dec, err := video.NewDecoder(w, h, colour, backend, frame)
	if err != nil && backend != "" {
		if !s.decoderFell.Swap(true) {
			s.logf("the %s decoder did not start (%v): using the automatic choice", backend, err)
		}
		dec, err = video.NewDecoder(w, h, colour, "", frame)
	}
	return dec, err
}

// redecode moves a running stream to the decoder now chosen.
func (v *viewer) redecode() {
	v.dmu.Lock()
	defer v.dmu.Unlock()
	v.mu.Lock()
	running := v.cancel != nil
	v.mu.Unlock()
	if v.dec == nil || !running {
		return
	}
	if err := v.startDecoder(); err != nil {
		go v.fail(err.Error())
	} else if v.sub != nil {
		v.sub.RequestKeyframe()
	}
}
