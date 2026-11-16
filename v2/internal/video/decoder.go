package video

import "harmony/v2/internal/video/native"

// Decoder turns an H.264 stream into RGBA pictures of a fixed size in a Frame, on the system's own decoder.
type Decoder struct {
	dec native.Decoder

	// W and H are the size of the pictures it makes.
	W, H int
}

// NewDecoder starts making w by h pictures into frame from a stream coded as colour says (what the stream's own
// parameter sets say wins), on the codec backend ("" is automatic, otherwise an ID from Decoders).
func NewDecoder(w, h int, colour Colour, backend string, frame *Frame) (*Decoder, error) {
	params := native.DecodeParams{Width: w, Height: h, Matrix: colour.Matrix, Full: colour.Full, Backend: backend}
	if frame.wantsGPU() {
		params.OnTexture = frame.publishGPU
	}
	dec, err := native.NewDecoder(params, func(rgba []byte, pw, ph int) {
		copy(frame.target(pw, ph), rgba)
		frame.publish()
	})
	if err != nil {
		return nil, err
	}
	return &Decoder{dec: dec, W: w, H: h}, nil
}

// Mode is the codec in use: videotoolbox, mediafoundation or vaapi.
func (d *Decoder) Mode() string { return d.dec.Mode() }

// Write hands over an access unit without waiting. It reports true when the decoder cannot show pictures until the next
// key frame: the moment to ask the sender for one.
func (d *Decoder) Write(au []byte) (needKeyframe bool) { return d.dec.Write(au) }

// Close ends the decoder.
func (d *Decoder) Close() { d.dec.Close() }
