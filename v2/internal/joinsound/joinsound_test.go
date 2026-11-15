package joinsound

import (
	"encoding/binary"
	"math"
	"testing"
)

func wav48(seconds float64) []byte {
	n := int(seconds * 48000)
	b := make([]byte, 44+4*n)
	copy(b, "RIFF")
	binary.LittleEndian.PutUint32(b[4:], uint32(36+4*n))
	copy(b[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(b[16:], 16)
	binary.LittleEndian.PutUint16(b[20:], 1)
	binary.LittleEndian.PutUint16(b[22:], 2)
	binary.LittleEndian.PutUint32(b[24:], 48000)
	binary.LittleEndian.PutUint32(b[28:], 48000*4)
	binary.LittleEndian.PutUint16(b[32:], 4)
	binary.LittleEndian.PutUint16(b[34:], 16)
	copy(b[36:], "data")
	binary.LittleEndian.PutUint32(b[40:], uint32(4*n))
	for i := 0; i < n; i++ {
		v := uint16(int16(12000 * math.Sin(float64(i)/20)))
		binary.LittleEndian.PutUint16(b[44+4*i:], v)
		binary.LittleEndian.PutUint16(b[46+4*i:], v)
	}
	return b
}

func TestLongSoundIsCutAndFaded(t *testing.T) {
	r, err := Convert(wav48(12))
	if err != nil {
		t.Fatal(err)
	}
	if !r.Trimmed || r.Seconds != MaxSeconds || len(r.WAV) != 44+2*MaxSeconds*Rate {
		t.Fatalf("trimmed=%v seconds=%v bytes=%d", r.Trimmed, r.Seconds, len(r.WAV))
	}
	if last := int16(binary.LittleEndian.Uint16(r.WAV[len(r.WAV)-2:])); last > 200 || last < -200 {
		t.Fatalf("does not end on a taper: %d", last)
	}
}

func TestNotAudioIsRefused(t *testing.T) {
	if _, err := Convert([]byte("hello")); err != ErrUnreadable {
		t.Fatal(err)
	}
}
