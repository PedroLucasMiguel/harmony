package native

import "math"

// BGRA to NV12 and NV12 to RGBA in pure Go, with the H.273 matrices this client uses (BT.709 and BT.601). The encoders
// and decoders of every platform share it; nothing here allocates.

// yuvCoef holds the conversion constants in Q16.
type yuvCoef struct {
	yr, yg, yb                                        int32 // Y' from R, G, B, limited range
	cbr, cbg, cbb                                     int32
	crr, crg, crb                                     int32
	toR, toGCr, toGCb, toB, yScaleLimited, yScaleFull int32 // YCbCr to RGB
}

const q16 = 1 << 16

func newYUVCoef(kr, kb float64) yuvCoef {
	kg := 1 - kr - kb
	r := func(v float64) int32 { return int32(math.Round(v * q16)) }
	const lumaRange, chromaRange = 219.0 / 255.0, 224.0 / 255.0
	cr := chromaRange / (2 * (1 - kr))
	cb := chromaRange / (2 * (1 - kb))
	return yuvCoef{
		yr: r(lumaRange * kr), yg: r(lumaRange * kg), yb: r(lumaRange * kb),
		cbr: r(-cb * kr), cbg: r(-cb * kg), cbb: r(cb * (1 - kb)),
		crr: r(cr * (1 - kr)), crg: r(-cr * kg), crb: r(-cr * kb),
		toR: r(2 * (1 - kr)), toB: r(2 * (1 - kb)),
		toGCr:         r(2 * (1 - kr) * kr / kg),
		toGCb:         r(2 * (1 - kb) * kb / kg),
		yScaleLimited: r(255.0 / 219.0),
		yScaleFull:    q16,
	}
}

var (
	coef709 = newYUVCoef(0.2126, 0.0722)
	coef601 = newYUVCoef(0.299, 0.114)
)

func coefFor(matrix int) *yuvCoef {
	if matrix == BT709 {
		return &coef709
	}
	return &coef601
}

func clamp8(v int32) byte {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return byte(v)
}

// nv12Size is the byte length of an NV12 picture whose rows are w bytes: w by h luma then w by h/2 interleaved chroma.
func nv12Size(w, h int) int { return w * (h + h/2) }

// bgraToNV12 converts a picture of w by h pixels (even sizes) to limited range NV12 with the matrix, into dst, which holds
// w*h luma bytes then w*h/2 chroma bytes. stride is the bytes a row of src takes; a negative stride says the rows are
// stored bottom first, -stride bytes apart. Chroma is the mean of each 2 by 2 block.
func bgraToNV12(dst, src []byte, w, h, stride int, matrix int) {
	c := coefFor(matrix)
	step, first := stride, 0
	if stride < 0 {
		step, first = stride, (h-1)*-stride
	}
	uvPlane := dst[w*h : nv12Size(w, h)]
	for y := 0; y < h; y += 2 {
		r0 := src[first+y*step : first+y*step+w*4]
		r1 := src[first+(y+1)*step : first+(y+1)*step+w*4]
		y0 := dst[y*w : y*w+w]
		y1 := dst[(y+1)*w : (y+1)*w+w]
		uv := uvPlane[(y/2)*w : (y/2)*w+w]
		for x := 0; x < w; x += 2 {
			p0, p1 := r0[x*4:x*4+8:x*4+8], r1[x*4:x*4+8:x*4+8]
			b00, g00, r00 := int32(p0[0]), int32(p0[1]), int32(p0[2])
			b01, g01, r01 := int32(p0[4]), int32(p0[5]), int32(p0[6])
			b10, g10, r10 := int32(p1[0]), int32(p1[1]), int32(p1[2])
			b11, g11, r11 := int32(p1[4]), int32(p1[5]), int32(p1[6])
			const yBias = 16*q16 + q16/2
			y0[x] = byte((c.yr*r00 + c.yg*g00 + c.yb*b00 + yBias) >> 16)
			y0[x+1] = byte((c.yr*r01 + c.yg*g01 + c.yb*b01 + yBias) >> 16)
			y1[x] = byte((c.yr*r10 + c.yg*g10 + c.yb*b10 + yBias) >> 16)
			y1[x+1] = byte((c.yr*r11 + c.yg*g11 + c.yb*b11 + yBias) >> 16)
			// the sums are of four pixels: (sum+2)>>2 is the mean, folded into the shift as >>18 with a bias of 2<<16
			rs, gs, bs := r00+r01+r10+r11, g00+g01+g10+g11, b00+b01+b10+b11
			const cBias = 128*q16*4 + q16*2
			uv[x] = byte((c.cbr*rs + c.cbg*gs + c.cbb*bs + cBias) >> 18)
			uv[x+1] = byte((c.crr*rs + c.crg*gs + c.crb*bs + cBias) >> 18)
		}
	}
}

// nv12ToRGBA converts an NV12 picture to tightly packed RGBA (w*h*4 bytes, alpha 255). y and uv are the luma and chroma
// planes with their row strides; w and h are even. full says the values use the whole 0 to 255 range.
func nv12ToRGBA(dst, y []byte, yStride int, uv []byte, uvStride int, w, h int, matrix int, full bool) {
	c := coefFor(matrix)
	ys, yo := c.yScaleLimited, int32(16)
	co := int32(128)
	if full {
		ys, yo = c.yScaleFull, 0
	}
	cs := int32(q16)
	if !full {
		cs = int32(math.Round(255.0 / 224.0 * q16))
	}
	toR := int32((int64(c.toR) * int64(cs)) >> 16)
	toB := int32((int64(c.toB) * int64(cs)) >> 16)
	toGCr := int32((int64(c.toGCr) * int64(cs)) >> 16)
	toGCb := int32((int64(c.toGCb) * int64(cs)) >> 16)
	for row := 0; row < h; row++ {
		yr := y[row*yStride : row*yStride+w]
		cr := uv[(row/2)*uvStride : (row/2)*uvStride+w]
		out := dst[row*w*4 : row*w*4+w*4]
		for x := 0; x < w; x += 2 {
			cb, cv := int32(cr[x])-co, int32(cr[x+1])-co
			rAdd := (toR*cv + q16/2) >> 16
			bAdd := (toB*cb + q16/2) >> 16
			gSub := (toGCr*cv + toGCb*cb + q16/2) >> 16
			for k := 0; k < 2; k++ {
				l := (ys*(int32(yr[x+k])-yo) + q16/2) >> 16
				o := out[(x+k)*4 : (x+k)*4+4 : (x+k)*4+4]
				o[0] = clamp8(l + rAdd)
				o[1] = clamp8(l - gSub)
				o[2] = clamp8(l + bAdd)
				o[3] = 255
			}
		}
	}
}
