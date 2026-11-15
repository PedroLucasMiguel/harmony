package native

// Copy of a tightly packed NV12 picture into a surface's image, whose rows are longer (pitch) and whose height is padded to
// whole macroblocks: the padding repeats the picture's last column and row, so that what the encoder predicts from at the
// picture's edge is the picture and not black.

func copyNV12Padded(dst []byte, offY, pitchY, offUV, pitchUV int, nv12 []byte, w, h, codedW, codedH int) bool {
	if pitchY < codedW || pitchUV < codedW || offY+pitchY*codedH > len(dst) || offUV+pitchUV*(codedH/2) > len(dst) || len(nv12) < w*h*3/2 {
		return false
	}
	for y := range codedH {
		src := nv12[min(y, h-1)*w:][:w]
		row := dst[offY+y*pitchY:][:codedW]
		copy(row, src)
		padRow(row[w:], src[w-1:][:1])
	}
	uv := nv12[w*h:]
	for y := range codedH / 2 {
		src := uv[min(y, h/2-1)*w:][:w]
		row := dst[offUV+y*pitchUV:][:codedW]
		copy(row, src)
		padRow(row[w:], src[w-2:])
	}
	return true
}

// padRow fills row with the repeating pattern.
func padRow(row, pattern []byte) {
	for i := range row {
		row[i] = pattern[i%len(pattern)]
	}
}
