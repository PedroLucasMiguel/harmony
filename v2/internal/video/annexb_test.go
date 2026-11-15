package video

import (
	"bytes"
	"io"
	"testing"
	"testing/iotest"
)

func nal(typ byte, long bool, body ...byte) []byte {
	sc := []byte{0, 0, 1}
	if long {
		sc = []byte{0, 0, 0, 1}
	}
	return append(append(sc, typ), body...)
}

func TestAccessUnitsSplitAtDelimiters(t *testing.T) {
	au1 := bytes.Join([][]byte{nal(0x09, true, 0xf0), nal(0x67, false, 1, 2, 3), nal(0x68, false, 4), nal(0x65, true, 5, 6, 7, 8)}, nil)
	au2 := bytes.Join([][]byte{nal(0x09, true, 0xf0), nal(0x41, true, 9, 9, 9)}, nil)
	au3 := bytes.Join([][]byte{nal(0x09, false, 0xf0), nal(0x41, false, 7)}, nil)
	stream := bytes.Join([][]byte{au1, au2, au3}, nil)

	for name, r := range map[string]io.Reader{
		"whole":    bytes.NewReader(stream),
		"one byte": iotest.OneByteReader(bytes.NewReader(stream)),
		"halves":   iotest.HalfReader(bytes.NewReader(stream)),
	} {
		reader := newAUReader(r)
		var got [][]byte
		for {
			au, err := reader.Next()
			if err != nil {
				break
			}
			got = append(got, au)
		}
		if len(got) != 3 {
			t.Fatalf("%s: %d access units, want 3", name, len(got))
		}
		for i, want := range [][]byte{au1, au2, au3} {
			if !bytes.Equal(got[i], want) {
				t.Errorf("%s: access unit %d is % x, want % x", name, i, got[i], want)
			}
		}
	}
}

func TestLeadingBytesAreDropped(t *testing.T) {
	stream := append(nal(0x67, true, 1, 2), nal(0x09, true, 0xf0)...)
	stream = append(stream, nal(0x65, true, 3)...)
	stream = append(stream, nal(0x09, true, 0xf0)...)
	reader := newAUReader(bytes.NewReader(stream))
	au, err := reader.Next()
	if err != nil {
		t.Fatal(err)
	}
	if nalType(au) != 9 || !bytes.Contains(au, []byte{0x65, 3}) || bytes.Contains(au, []byte{0x67, 1, 2}) {
		t.Errorf("first access unit is % x", au)
	}
}
