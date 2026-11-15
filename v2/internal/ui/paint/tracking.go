package paint

import (
	"encoding/binary"

	"github.com/go-text/typesetting/font/opentype"
)

type tracking struct {
	sizes, values []float32
	upem          float32
}

const trackHeaderSize = 8

// The font's own tracking table, which CoreText applies and Chromium therefore matches.
func readTracking(loader *opentype.Loader, upem float32) tracking {
	data, err := loader.RawTable(opentype.MustNewTag("trak"))
	if err != nil || len(data) < 12 {
		return tracking{}
	}
	horizontal := int(binary.BigEndian.Uint16(data[6:]))
	if horizontal == 0 || len(data) < horizontal+trackHeaderSize {
		return tracking{}
	}
	tracks := int(binary.BigEndian.Uint16(data[horizontal:]))
	sizes := int(binary.BigEndian.Uint16(data[horizontal+2:]))
	sizeTable := int(binary.BigEndian.Uint32(data[horizontal+4:]))
	t := tracking{upem: upem}
	for i := 0; i < sizes; i++ {
		t.sizes = append(t.sizes, float32(binary.BigEndian.Uint32(data[sizeTable+4*i:]))/65536)
	}
	for i := 0; i < tracks; i++ {
		entry := horizontal + trackHeaderSize + 8*i
		if int32(binary.BigEndian.Uint32(data[entry:])) != 0 {
			continue
		}
		values := int(binary.BigEndian.Uint16(data[entry+6:]))
		for j := 0; j < sizes; j++ {
			t.values = append(t.values, float32(int16(binary.BigEndian.Uint16(data[values+2*j:]))))
		}
	}
	if len(t.values) != len(t.sizes) {
		return tracking{}
	}
	return t
}

func (t tracking) perGlyph(size float32) float32 {
	n := len(t.sizes)
	if n == 0 {
		return 0
	}
	value := t.values[n-1]
	switch {
	case size <= t.sizes[0]:
		value = t.values[0]
	case size < t.sizes[n-1]:
		for i := 1; i < n; i++ {
			if size <= t.sizes[i] {
				span := (size - t.sizes[i-1]) / (t.sizes[i] - t.sizes[i-1])
				value = t.values[i-1] + span*(t.values[i]-t.values[i-1])
				break
			}
		}
	}
	return value / t.upem * size
}
