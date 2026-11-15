//go:build darwin

package native

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func TestMdecParseSPS(t *testing.T) {
	// x264, High profile, 1280x720, colour description BT.709 limited range.
	sps, _ := hex.DecodeString("6764001facb402802dd80b50202014000003000400000300f23c60ca80")
	p, ok := mdecParseSPS(sps)
	if !ok || p.w != 1280 || p.h != 720 || p.matrix != 1 || p.full || !p.tagged {
		t.Fatalf("got %+v ok=%v", p, ok)
	}
	if _, ok := mdecParseSPS(sps[:4]); ok {
		t.Fatal("a cut parameter set parsed")
	}
}

func TestMdecSplit(t *testing.T) {
	au := []byte{0, 0, 0, 1, 9, 0xf0, 0, 0, 1, 0x65, 1, 2, 0, 0, 0, 0, 1, 0x41, 7}
	got := mdecSplit(au, nil)
	want := [][]byte{{9, 0xf0}, {0x65, 1, 2}, {0x41, 7}}
	if len(got) != len(want) {
		t.Fatalf("got %x", got)
	}
	for i := range want {
		if !bytes.Equal(got[i], want[i]) {
			t.Fatalf("unit %d: got %x want %x", i, got[i], want[i])
		}
	}
}
