package native

import (
	"bytes"
	"testing"
)

type spsFields struct {
	hasSignal, full             bool
	primaries, transfer, matrix int
	reorder, buffering          int
	timing                      bool
}

// buildSPS writes a baseline SPS for 640x480; vui is nil for none.
func buildSPS(withVUI bool, vuiMatrix int) []byte { return buildSPSProfile(66, withVUI, vuiMatrix) }

func buildSPSProfile(profile int, withVUI bool, vuiMatrix int) []byte {
	w := &spsWriter{}
	w.bits(profile, 8)
	w.bits(0xc0, 8)
	w.bits(30, 8)
	w.ue(0)
	if profile == 100 {
		w.ue(1)
		w.ue(0)
		w.ue(0)
		w.bit(0)
		w.bit(0)
	}
	w.ue(0)
	w.ue(2)
	w.ue(4)
	w.bit(0)
	w.ue(39)
	w.ue(29)
	w.bit(1)
	w.bit(1)
	w.bit(0)
	if !withVUI {
		w.bit(0)
	} else {
		w.bit(1)
		w.bit(1) // aspect
		w.bits(255, 8)
		w.bits(1, 16)
		w.bits(1, 16)
		w.bit(0)
		w.bit(1) // video signal type
		w.bits(2, 3)
		w.bit(1)
		w.bit(1)
		w.bits(vuiMatrix, 8)
		w.bits(vuiMatrix, 8)
		w.bits(vuiMatrix, 8)
		w.bit(0)
		w.bit(1) // timing
		w.bits(1001, 32)
		w.bits(60000, 32)
		w.bit(1)
		w.bit(0)
		w.bit(0)
		w.bit(0)
		w.bit(0)
		w.bit(0)
	}
	w.bit(1)
	for w.n != 0 {
		w.bit(0)
	}
	return append([]byte{0x67}, escapeNAL(nil, w.b)...)
}

// readVUI walks a baseline SPS as tagSPS writes it.
func readVUI(t *testing.T, nal []byte) spsFields {
	t.Helper()
	r := &spsReader{b: unescapeNAL(nil, nal[1:])}
	profile := r.bits(8)
	r.bits(16)
	r.ue()
	if profile == 100 {
		r.ue()
		r.ue()
		r.ue()
		r.bits(2)
	}
	r.ue()
	if r.ue() == 0 {
		r.ue()
	}
	r.ue()
	r.bit()
	r.ue()
	r.ue()
	if r.bit() == 0 {
		r.bit()
	}
	r.bit()
	if r.bit() == 1 {
		for i := 0; i < 4; i++ {
			r.ue()
		}
	}
	if r.bit() == 0 {
		t.Fatal("no VUI")
	}
	var f spsFields
	if r.bit() == 1 && r.bits(8) == 255 {
		r.bits(32)
	}
	if r.bit() == 1 {
		r.bit()
	}
	if r.bit() == 1 {
		r.bits(3)
		f.full = r.bit() == 1
		if r.bit() == 1 {
			f.hasSignal = true
			f.primaries, f.transfer, f.matrix = r.bits(8), r.bits(8), r.bits(8)
		}
	}
	if r.bit() == 1 {
		r.ue()
		r.ue()
	}
	if r.bit() == 1 {
		f.timing = true
		r.bits(64)
		r.bit()
	}
	hrd := r.bit() | r.bit()
	if hrd != 0 {
		t.Fatal("unexpected hrd")
	}
	r.bit()
	if r.bit() == 1 {
		r.bit()
		r.ue()
		r.ue()
		r.ue()
		r.ue()
		f.reorder = r.ue()
		f.buffering = r.ue()
	}
	if r.bad {
		t.Fatal("ran out of bits")
	}
	return f
}

func TestTagSPSWithoutVUI(t *testing.T) {
	var scratch []byte
	for _, m := range []int{BT709, BT601} {
		got := readVUI(t, tagSPS(&scratch, buildSPS(false, 0), m))
		p, tr, mat := spsColourDescription(m)
		if !got.hasSignal || got.full || got.primaries != p || got.transfer != tr || got.matrix != mat {
			t.Errorf("matrix %d: %+v", m, got)
		}
		if got.reorder != 0 || got.buffering != 4 {
			t.Errorf("restriction %+v", got)
		}
	}
}

func TestTagSPSReplacesVUI(t *testing.T) {
	var scratch []byte
	got := readVUI(t, tagSPS(&scratch, buildSPS(true, 2), BT709))
	if !got.hasSignal || got.full || got.matrix != 1 || !got.timing {
		t.Errorf("%+v", got)
	}
}

func TestStreamFixerAddsParameterSets(t *testing.T) {
	f := &streamFixer{matrix: BT709}
	pps := []byte{0x68, 0xce, 0x3c, 0x80}
	idr := []byte{0x65, 0x88, 0x84, 0x11, 0x22}
	withParams := append(append(append(append([]byte{}, fixStartCode4...), buildSPS(false, 0)...), append(fixStartCode4, pps...)...), append(fixStartCode4, idr...)...)
	first := append([]byte(nil), f.fix(withParams)...)
	if bytes.Count(first, fixStartCode4) != 3 || first[4]&0x1f != fixNalSPS {
		t.Fatalf("first: % x", first)
	}
	bare := append(append([]byte{0, 0, 0, 1, 0x09, 0xf0}, fixStartCode4...), idr...)
	second := f.fix(bare)
	if bytes.Count(second, fixStartCode4) != 4 {
		t.Fatalf("bare key frame did not get parameter sets: % x", second)
	}
	if !bytes.HasSuffix(second, idr) {
		t.Fatalf("slice altered: % x", second)
	}
	p := append(append([]byte{}, fixStartCode4...), 0x41, 0x9a, 1)
	if out := f.fix(p); !bytes.Equal(out, p) {
		t.Fatalf("P frame altered: % x", out)
	}
}

func TestTagSPSHighProfile(t *testing.T) {
	var scratch []byte
	got := readVUI(t, tagSPS(&scratch, buildSPSProfile(100, false, 0), BT709))
	if !got.hasSignal || got.matrix != 1 || got.reorder != 0 || got.buffering != 4 {
		t.Errorf("%+v", got)
	}
}
