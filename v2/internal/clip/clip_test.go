package clip

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func wavFile(rate, channels, bits int, samples []byte) []byte {
	var b bytes.Buffer
	b.WriteString("RIFF")
	binary.Write(&b, binary.LittleEndian, uint32(36+len(samples)))
	b.WriteString("WAVEfmt ")
	binary.Write(&b, binary.LittleEndian, uint32(16))
	binary.Write(&b, binary.LittleEndian, uint16(1))
	binary.Write(&b, binary.LittleEndian, uint16(channels))
	binary.Write(&b, binary.LittleEndian, uint32(rate))
	binary.Write(&b, binary.LittleEndian, uint32(rate*channels*bits/8))
	binary.Write(&b, binary.LittleEndian, uint16(channels*bits/8))
	binary.Write(&b, binary.LittleEndian, uint16(bits))
	b.WriteString("data")
	binary.Write(&b, binary.LittleEndian, uint32(len(samples)))
	b.Write(samples)
	return b.Bytes()
}

func TestWAVBecomesStereoAtMixerRate(t *testing.T) {
	raw := make([]byte, 2*800)
	for i := 0; i < 800; i++ {
		binary.LittleEndian.PutUint16(raw[2*i:], uint16(int16(1000*(i%2*2-1))))
	}
	pcm, err := Decode(wavFile(8000, 1, 16, raw))
	if err != nil {
		t.Fatal(err)
	}
	if want := 800 * Rate / 8000 * 2; len(pcm) != want {
		t.Fatalf("got %d samples, want %d", len(pcm), want)
	}
	if pcm[2*10] != pcm[2*10+1] {
		t.Fatal("a mono clip should play the same on both sides")
	}
}

func TestOggPacketsAcrossLacingAndPages(t *testing.T) {
	page := func(flags byte, table []byte, body []byte) []byte {
		h := append([]byte("OggS"), 0, flags)
		h = append(h, make([]byte, 20)...)
		h = append(h, byte(len(table)))
		return append(append(h, table...), body...)
	}
	long := bytes.Repeat([]byte{7}, 300)
	data := append(page(0, []byte{255, 45, 3}, append(append([]byte{}, long...), 1, 2, 3)), page(1, []byte{4}, []byte{9, 9, 9, 9})...)
	packets := oggPackets(data)
	if len(packets) != 3 || len(packets[0]) != 300 || len(packets[1]) != 3 || len(packets[2]) != 4 {
		t.Fatalf("got %d packets: %v", len(packets), packets)
	}
}

func TestUnknownSizeIsRecognised(t *testing.T) {
	if _, n, unknown := readVint([]byte{0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF}); n != 8 || !unknown {
		t.Fatalf("n=%d unknown=%v", n, unknown)
	}
	if v, n, unknown := readVint([]byte{0x42, 0x86}); v != 0x286 || n != 2 || unknown {
		t.Fatalf("v=%x n=%d unknown=%v", v, n, unknown)
	}
}

func TestUnknownFormatIsRefused(t *testing.T) {
	if _, err := Decode([]byte("not audio at all")); err != ErrUnsupported {
		t.Fatal(err)
	}
}
