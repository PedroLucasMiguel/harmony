package native

import (
	"encoding/binary"
	"testing"
)

func TestEnumVideoFormatIsWellFormed(t *testing.T) {
	pod := enumVideoFormat(30)
	if got := int(binary.LittleEndian.Uint32(pod)) + 8; got != len(pod) || len(pod)%8 != 0 {
		t.Fatalf("pod size says %d, there are %d bytes", got, len(pod))
	}
	// Walk the properties the way PipeWire does: each one is a key, flags and a value pod padded to 8 bytes.
	keys := 0
	for off := 16; off < len(pod); keys++ {
		vsize := int(binary.LittleEndian.Uint32(pod[off+8:]))
		off += 16 + (vsize+7)&^7
	}
	if keys != 5 {
		t.Errorf("%d properties, want 5", keys)
	}
}

func TestVideoFormatReadsFixatedPod(t *testing.T) {
	var w podWriter
	w.u32(0, spaTypeObject, spaObjectFormat, spaParamFormat)
	w.idProp(spaFormatMediaType, spaMediaTypeVideo)
	w.idProp(spaFormatVideoFormat, spaVideoBGRx)
	w.u32(spaFormatVideoSize, 0, 8, spaTypeRectangle, 2560, 1440)
	w.u32(spaFormatVideoRate, 0, 8, spaTypeFraction, 60, 1)
	binary.LittleEndian.PutUint32(w.b, uint32(len(w.b)-8))
	f, wd, ht, ok := videoFormat(w.b)
	if !ok || f != spaVideoBGRx || wd != 2560 || ht != 1440 {
		t.Errorf("got %d %dx%d ok=%v", f, wd, ht, ok)
	}
}
