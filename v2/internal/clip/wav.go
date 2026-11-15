package clip

import (
	"encoding/binary"
	"math"
)

const (
	wavPCM        = 1
	wavFloat      = 3
	wavExtensible = 0xFFFE
)

func decodeWAV(data []byte) ([]int16, error) {
	if len(data) < 12 || string(data[8:12]) != "WAVE" {
		return nil, ErrUnsupported
	}
	var format, channels, bits, rate int
	for rest := data[12:]; len(rest) >= 8; {
		id, size := string(rest[:4]), int(binary.LittleEndian.Uint32(rest[4:8]))
		body := rest[8:]
		size = min(size, len(body))
		switch id {
		case "fmt ":
			if size < 16 {
				return nil, ErrUnsupported
			}
			format = int(binary.LittleEndian.Uint16(body[0:2]))
			channels = int(binary.LittleEndian.Uint16(body[2:4]))
			rate = int(binary.LittleEndian.Uint32(body[4:8]))
			bits = int(binary.LittleEndian.Uint16(body[14:16]))
			if format == wavExtensible && size >= 26 {
				format = int(binary.LittleEndian.Uint16(body[24:26]))
			}
		case "data":
			samples, err := wavSamples(body[:size], format, bits)
			if err != nil {
				return nil, err
			}
			return stereo48k(samples, rate, channels)
		}
		rest = body[min(size+size&1, len(body)):]
	}
	return nil, ErrUnsupported
}

func wavSamples(raw []byte, format, bits int) ([]int16, error) {
	width := bits / 8
	if width == 0 || bits%8 != 0 || (format != wavPCM && format != wavFloat) {
		return nil, ErrUnsupported
	}
	out := make([]int16, len(raw)/width)
	for i := range out {
		b := raw[i*width : (i+1)*width]
		switch {
		case format == wavFloat && width == 4:
			out[i] = clamp16(float64(math.Float32frombits(binary.LittleEndian.Uint32(b))) * 32768)
		case format == wavFloat && width == 8:
			out[i] = clamp16(math.Float64frombits(binary.LittleEndian.Uint64(b)) * 32768)
		case format == wavPCM && width == 1:
			out[i] = int16(int(b[0])-128) << 8
		case format == wavPCM && width >= 2 && width <= 4:
			out[i] = int16(binary.LittleEndian.Uint16(b[width-2:]))
		default:
			return nil, ErrUnsupported
		}
	}
	return out, nil
}

func clamp16(v float64) int16 { return int16(math.Max(math.MinInt16, math.Min(math.MaxInt16, v))) }
