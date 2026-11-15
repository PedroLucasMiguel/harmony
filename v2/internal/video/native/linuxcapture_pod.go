package native

// The bytes of the SPA pods PipeWire is spoken to in (spa/pod/pod.h): the format a screen capture asks for, and the reading
// of the format that comes back. Every pod has a size and type header of two 32-bit words, and is padded to 8 bytes.

import "encoding/binary"

const (
	spaTypeID        = 3
	spaTypeRectangle = 10
	spaTypeFraction  = 11
	spaTypeObject    = 15
	spaTypeChoice    = 19

	spaChoiceRange = 1
	spaChoiceEnum  = 3

	spaObjectFormat = 0x40003
	spaParamEnumFmt = 3
	spaParamFormat  = 4

	spaFormatMediaType    = 1
	spaFormatMediaSubtype = 2
	spaFormatVideoFormat  = 0x20001
	spaFormatVideoSize    = 0x20003
	spaFormatVideoRate    = 0x20004

	spaMediaTypeVideo = 2
	spaSubtypeRaw     = 1

	spaVideoRGBx = 7
	spaVideoBGRx = 8
	spaVideoRGBA = 11
	spaVideoBGRA = 12
)

type podWriter struct{ b []byte }

func (w *podWriter) u32(vs ...uint32) {
	for _, v := range vs {
		w.b = binary.LittleEndian.AppendUint32(w.b, v)
	}
}

func (w *podWriter) pad() {
	for len(w.b)%8 != 0 {
		w.b = append(w.b, 0)
	}
}

// idProp is a property with one Id value.
func (w *podWriter) idProp(key, id uint32) {
	w.u32(key, 0, 4, spaTypeID, id, 0)
}

// choiceProp is a property with a choice of values of one child type: each value is count32 words.
func (w *podWriter) choiceProp(key, choice, childType, childSize uint32, values ...uint32) {
	body := 16 + uint32(len(values))*4
	w.u32(key, 0, body, spaTypeChoice, choice, 0, childSize, childType)
	w.u32(values...)
	w.pad()
}

// enumVideoFormat is the object that asks for raw video in the 4-byte RGB formats, any size, and the frame rate.
func enumVideoFormat(fps int) []byte {
	var w podWriter
	w.u32(0, spaTypeObject, spaObjectFormat, spaParamEnumFmt)
	w.idProp(spaFormatMediaType, spaMediaTypeVideo)
	w.idProp(spaFormatMediaSubtype, spaSubtypeRaw)
	w.choiceProp(spaFormatVideoFormat, spaChoiceEnum, spaTypeID, 4, spaVideoBGRx, spaVideoBGRx, spaVideoBGRA, spaVideoRGBx, spaVideoRGBA)
	w.choiceProp(spaFormatVideoSize, spaChoiceRange, spaTypeRectangle, 8, 1920, 1080, 1, 1, 8192, 8192)
	w.choiceProp(spaFormatVideoRate, spaChoiceRange, spaTypeFraction, 8, uint32(fps), 1, 0, 1, 360, 1)
	binary.LittleEndian.PutUint32(w.b, uint32(len(w.b)-8))
	return w.b
}

// videoFormat reads the video format and size from a pod that PipeWire fixated (plain values, no choices).
func videoFormat(pod []byte) (format uint32, w, h int, ok bool) {
	if len(pod) < 16 || binary.LittleEndian.Uint32(pod[4:]) != spaTypeObject {
		return 0, 0, 0, false
	}
	size := min(int(binary.LittleEndian.Uint32(pod))+8, len(pod))
	for off := 16; off+16 <= size; {
		key := binary.LittleEndian.Uint32(pod[off:])
		vsize := int(binary.LittleEndian.Uint32(pod[off+8:]))
		vtype := binary.LittleEndian.Uint32(pod[off+12:])
		body := pod[off+16:]
		if vsize > len(body) {
			break
		}
		switch {
		case key == spaFormatVideoFormat && vtype == spaTypeID && vsize >= 4:
			format = binary.LittleEndian.Uint32(body)
		case key == spaFormatVideoSize && vtype == spaTypeRectangle && vsize >= 8:
			w, h = int(binary.LittleEndian.Uint32(body)), int(binary.LittleEndian.Uint32(body[4:]))
		}
		off += 16 + (vsize+7)&^7
	}
	return format, w, h, format != 0 && w > 0 && h > 0
}

// rgbOrder says whether the format has red first in memory.
func rgbOrder(format uint32) bool { return format == spaVideoRGBx || format == spaVideoRGBA }

func knownVideoFormat(format uint32) bool {
	switch format {
	case spaVideoRGBx, spaVideoBGRx, spaVideoRGBA, spaVideoBGRA:
		return true
	}
	return false
}
