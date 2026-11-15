package native

// What a camera hands over (YUYV, NV12 or Motion-JPEG) turned into an NV12 picture of the stream's size, scaled in the
// Y'CbCr domain so that the camera's own coding is kept: the matrix the stream is tagged with is the caller's to choose.
// JPEG is full range and is brought to the limited range the stream is tagged with.

import (
	"bytes"
	"errors"
	"image"
	"image/jpeg"
)

const (
	v4l2PixYUYV = 0x56595559
	v4l2PixNV12 = 0x3231564e
	v4l2PixMJPG = 0x47504a4d
)

var (
	jpegLumaLUT   [256]byte
	jpegChromaLUT [256]byte
)

func init() {
	for i := range 256 {
		jpegLumaLUT[i] = byte(16 + (i*219+127)/255)
		jpegChromaLUT[i] = byte(min(max(128+((i-128)*224+127*sign(i-128))/255, 16), 240))
	}
}

func sign(v int) int {
	if v < 0 {
		return -1
	}
	return 1
}

type camConverter struct {
	fourcc         uint32
	sw, sh, stride int
	dw, dh         int
	y, uv          *capScaler
	tmpY, tmpUV    []byte
	// Motion-JPEG: planes of the decoded picture are scaled one at a time.
	jpegY, jpegC *capScaler
	jpegDims     [4]int
	cb, cr       []byte
	withTables   []byte
}

// newCamConverter converts frames of sw by sh pixels (stride bytes a row, 0 for the packed one) to dw by dh.
func newCamConverter(fourcc uint32, sw, sh, stride, dw, dh int) *camConverter {
	c := &camConverter{fourcc: fourcc, sw: sw, sh: sh, stride: stride, dw: dw, dh: dh}
	if fourcc == v4l2PixYUYV && stride == 0 {
		c.stride = sw * 2
	}
	if fourcc == v4l2PixNV12 && stride == 0 {
		c.stride = sw
	}
	switch fourcc {
	case v4l2PixYUYV, v4l2PixNV12:
		c.y = newCapScaler(sw, sh, dw, dh, 1)
		c.uv = newCapScaler(sw/2, sh/2, dw/2, dh/2, 2)
	}
	if fourcc == v4l2PixYUYV {
		c.tmpY = make([]byte, sw*sh)
		c.tmpUV = make([]byte, sw*sh/2)
	}
	return c
}

var errShortFrame = errors.New("the camera sent a short picture")

// convert fills dst (nv12Size(dw, dh) bytes) from one camera frame.
func (c *camConverter) convert(dst, frame []byte) error {
	switch c.fourcc {
	case v4l2PixYUYV:
		if len(frame) < c.stride*c.sh {
			return errShortFrame
		}
		yuyvSplit(c.tmpY, c.tmpUV, frame, c.stride, c.sw, c.sh)
		c.y.scale(dst[:c.dw*c.dh], c.dw, c.tmpY, c.sw)
		c.uv.scale(dst[c.dw*c.dh:], c.dw, c.tmpUV, c.sw)
	case v4l2PixNV12:
		if len(frame) < c.stride*c.sh*3/2 {
			return errShortFrame
		}
		c.y.scale(dst[:c.dw*c.dh], c.dw, frame, c.stride)
		c.uv.scale(dst[c.dw*c.dh:], c.dw, frame[c.stride*c.sh:], c.stride)
	case v4l2PixMJPG:
		return c.convertJPEG(dst, frame)
	default:
		return errors.New("the camera's picture format is not supported")
	}
	return nil
}

// yuyvSplit makes a luma plane and an interleaved chroma plane at half height from packed 4:2:2.
func yuyvSplit(y, uv, src []byte, stride, w, h int) {
	for r := range h {
		row := src[r*stride:][:w*2]
		out := y[r*w:][:w]
		for x := range w {
			out[x] = row[2*x]
		}
	}
	for r := range h / 2 {
		a, b := src[2*r*stride:][:w*2], src[(2*r+1)*stride:][:w*2]
		out := uv[r*w:][:w]
		for c := 0; c < w; c += 2 {
			out[c] = byte((int(a[2*c+1]) + int(b[2*c+1]) + 1) / 2)
			out[c+1] = byte((int(a[2*c+3]) + int(b[2*c+3]) + 1) / 2)
		}
	}
}

func (c *camConverter) convertJPEG(dst, frame []byte) error {
	if !bytes.Contains(frame[:min(len(frame), 700)], []byte{0xff, 0xc4}) && len(frame) > 2 {
		c.withTables = append(append(append(c.withTables[:0], frame[:2]...), mjpegHuffmanTables...), frame[2:]...)
		frame = c.withTables
	}
	img, err := jpeg.Decode(bytes.NewReader(frame))
	if err != nil {
		return err
	}
	ycc, ok := img.(*image.YCbCr)
	if !ok {
		return errors.New("the camera's JPEG pictures are not Y'CbCr")
	}
	sw, sh := ycc.Rect.Dx(), ycc.Rect.Dy()
	cw, chh := chromaSize(ycc.SubsampleRatio, sw, sh)
	if dims := [4]int{sw, sh, cw, chh}; dims != c.jpegDims {
		c.jpegDims = dims
		c.jpegY = newCapScaler(sw, sh, c.dw, c.dh, 1)
		c.jpegC = newCapScaler(cw, chh, c.dw/2, c.dh/2, 1)
		c.cb, c.cr = make([]byte, c.dw/2*c.dh/2), make([]byte, c.dw/2*c.dh/2)
	}
	luma := dst[:c.dw*c.dh]
	c.jpegY.scale(luma, c.dw, ycc.Y, ycc.YStride)
	for i, v := range luma {
		luma[i] = jpegLumaLUT[v]
	}
	c.jpegC.scale(c.cb, c.dw/2, ycc.Cb, ycc.CStride)
	c.jpegC.scale(c.cr, c.dw/2, ycc.Cr, ycc.CStride)
	uv := dst[c.dw*c.dh:]
	for i := range c.cb {
		uv[2*i], uv[2*i+1] = jpegChromaLUT[c.cb[i]], jpegChromaLUT[c.cr[i]]
	}
	return nil
}

func chromaSize(r image.YCbCrSubsampleRatio, w, h int) (int, int) {
	switch r {
	case image.YCbCrSubsampleRatio422:
		return (w + 1) / 2, h
	case image.YCbCrSubsampleRatio420:
		return (w + 1) / 2, (h + 1) / 2
	case image.YCbCrSubsampleRatio440:
		return w, (h + 1) / 2
	case image.YCbCrSubsampleRatio411:
		return (w + 3) / 4, h
	case image.YCbCrSubsampleRatio410:
		return (w + 3) / 4, (h + 1) / 2
	}
	return w, h
}
