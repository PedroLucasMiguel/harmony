//go:build darwin

package native

import (
	"bytes"
	"testing"
)

func TestAVCCToAnnexB(t *testing.T) {
	src := []byte{0, 0, 0, 3, 0x65, 1, 2, 0, 0, 0, 2, 0x41, 9, 0, 0, 0, 9, 1}
	want := []byte{0, 0, 0, 1, 0x65, 1, 2, 0, 0, 0, 1, 0x41, 9}
	if got := avccToAnnexB([]byte{}, src); !bytes.Equal(got, want) {
		t.Fatalf("got % x, want % x", got, want)
	}
	if got := avccToAnnexB(nil, []byte{0, 0, 0, 0, 1}); len(got) != 0 {
		t.Fatalf("an empty unit gave % x", got)
	}
}
