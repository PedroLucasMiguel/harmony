package native

// The H.264 parameter sets a VA-API encoder is handed as packed headers: the driver writes the slices, the client
// writes the headers that say how the stream is coded, colour description included.

const (
	h264ProfileBaseline = 66
	h264ProfileMain     = 77
	h264ProfileHigh     = 100
	h264NALSPS          = 7
	h264NALPPS          = 8
	h264SliceP          = 0
	h264SliceI          = 2
)

type h264Config struct {
	W, H            int
	FPS             int
	Matrix          int
	Profile         byte
	Level           byte
	CABAC           bool
	InitQP          int
	Log2MaxFrameNum int
	// POCType is 0 for streams made by the encoders here and 2 for the reference streams the tests compare with.
	POCType        int
	Log2MaxPOCLsb  int
	Log2MaxMV      int
	MaxDecBuffered int
}

func (c *h264Config) mbW() int { return (c.W + 15) / 16 }
func (c *h264Config) mbH() int { return (c.H + 15) / 16 }

// colourMatrix is the H.273 matrix the stream is tagged with.
func (c *h264Config) colourMatrix() uint32 {
	if c.Matrix == BT601 {
		return BT601
	}
	return BT709
}

var h264Levels = [...]struct {
	idc         byte
	mbps, fs    int
	maxBitrateK int
}{
	{10, 1485, 99, 64}, {11, 3000, 396, 192}, {12, 6000, 396, 384}, {13, 11880, 396, 768}, {20, 11880, 396, 2000},
	{21, 19800, 792, 4000}, {22, 20250, 1620, 4000}, {30, 40500, 1620, 10000}, {31, 108000, 3600, 14000},
	{32, 216000, 5120, 20000}, {40, 245760, 8192, 20000}, {41, 245760, 8192, 50000}, {42, 522240, 8704, 50000},
	{50, 589824, 22080, 135000}, {51, 983040, 36864, 240000}, {52, 2073600, 36864, 240000},
}

// h264Level is the lowest level that holds this picture size, frame rate and bit rate.
func h264Level(w, h, fps, kbps int) byte {
	mbs := (w + 15) / 16 * ((h + 15) / 16)
	for _, l := range h264Levels {
		if mbs <= l.fs && mbs*fps <= l.mbps && kbps <= l.maxBitrateK {
			return l.idc
		}
	}
	return h264Levels[len(h264Levels)-1].idc
}

// newH264Config is the stream's coding for a profile (66, 77 or 100): CAVLC for constrained baseline, CABAC above it.
func newH264Config(w, h, fps, kbps, matrix int, profile byte) h264Config {
	return h264Config{
		W: w, H: h, FPS: fps, Matrix: matrix, Profile: profile, CABAC: profile != h264ProfileBaseline,
		Level: h264Level(w, h, fps, kbps), InitQP: 26, Log2MaxFrameNum: 8, Log2MaxPOCLsb: 8, Log2MaxMV: 16, MaxDecBuffered: 1,
	}
}

func (c *h264Config) startNAL(w *vaBitWriter, refIdc, typ int) {
	w.buf = append(w.buf, 0, 0, 0, 1, byte(refIdc<<5|typ))
	w.epb = true
	w.zeros = 0
}

func (c *h264Config) appendSPS(buf []byte) []byte {
	var w vaBitWriter
	w.reset(buf)
	c.startNAL(&w, 3, h264NALSPS)
	w.bits(uint32(c.Profile), 8)
	switch c.Profile {
	case h264ProfileBaseline:
		w.bits(0xc0, 8) // constraint_set0 and 1: constrained baseline
	case h264ProfileMain:
		w.bits(0x40, 8)
	default:
		w.bits(0, 8)
	}
	w.bits(uint32(c.Level), 8)
	w.ue(0)
	if c.Profile == h264ProfileHigh {
		w.ue(1) // 4:2:0
		w.ue(0)
		w.ue(0)
		w.bit(0)
		w.bit(0)
	}
	w.ue(uint32(c.Log2MaxFrameNum - 4))
	w.ue(uint32(c.POCType))
	if c.POCType == 0 {
		w.ue(uint32(c.Log2MaxPOCLsb - 4))
	}
	w.ue(1)
	w.bit(0)
	w.ue(uint32(c.mbW() - 1))
	w.ue(uint32(c.mbH() - 1))
	w.bit(1)
	w.bit(1)
	cropX, cropY := (c.mbW()*16-c.W)/2, (c.mbH()*16-c.H)/2
	w.flag(cropX|cropY != 0)
	if cropX|cropY != 0 {
		w.ue(0)
		w.ue(uint32(cropX))
		w.ue(0)
		w.ue(uint32(cropY))
	}
	w.bit(1)
	c.vui(&w)
	w.trailing()
	return w.buf
}

func (c *h264Config) vui(w *vaBitWriter) {
	w.bit(1)
	w.bits(1, 8) // square pixels
	w.bit(0)
	w.bit(1)
	w.bits(5, 3) // video_format: unspecified
	w.bit(0)     // limited range
	w.bit(1)
	w.bits(1, 8) // BT.709 primaries and transfer for either matrix, as the other encoders tag it
	w.bits(1, 8)
	w.bits(c.colourMatrix(), 8)
	w.bit(0)
	w.bit(1)
	w.bits(1, 32)
	w.bits(uint32(2*c.FPS), 32)
	w.bit(0)
	w.bit(0)
	w.bit(0)
	w.bit(0)
	w.bit(1)
	w.bit(1)
	w.ue(0)
	w.ue(0)
	w.ue(uint32(c.Log2MaxMV))
	w.ue(uint32(c.Log2MaxMV))
	w.ue(0) // no picture comes out of order, so a decoder shows each one at once
	w.ue(uint32(c.MaxDecBuffered))
}

func (c *h264Config) appendPPS(buf []byte) []byte {
	var w vaBitWriter
	w.reset(buf)
	c.startNAL(&w, 3, h264NALPPS)
	w.ue(0)
	w.ue(0)
	w.flag(c.CABAC)
	w.bit(0)
	w.ue(0)
	w.ue(0)
	w.ue(0)
	w.bit(0)
	w.bits(0, 2)
	w.se(int32(c.InitQP - 26))
	w.se(0)
	w.se(0)
	w.bit(1)
	w.bit(0)
	w.bit(0)
	if c.Profile == h264ProfileHigh {
		w.bit(1) // transform_8x8_mode_flag
		w.bit(0)
		w.se(0)
	}
	w.trailing()
	return w.buf
}
