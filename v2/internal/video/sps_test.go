package video

import (
	"encoding/hex"
	"testing"

	"harmony/v2/internal/video/native"
)

func TestPictureSizeReadsCroppedAndUncropped(t *testing.T) {
	for name, c := range map[string]struct {
		au   string
		w, h int
	}{
		"baseline 720p":        {"000000010910000000016742c01fd9005005bb0110000003001000000300a0f1832480", 1280, 720},
		"baseline 1080p, crop": {"000000010910000000016742c028d900780227e5c044000003000400000300283c60c920", 1920, 1080},
		"baseline 360p, crop":  {"000000010910000000016742c016d900a02ff970110000030001000003000a0f162e48", 640, 360},
		"high 180p, crop":      {"000000010910000000016764000cacd941419f9f0110000003001000000300a0f1429960", 320, 180},
		"high 360p, crop":      {"0000000109100000000167640016acd940a02ff970110000030001000003000a0f162d96", 640, 360},
		"no parameter set":     {"00000001091000000001419a", 0, 0},
	} {
		au, _ := hex.DecodeString(c.au)
		if w, h := PictureSize(au); w != c.w || h != c.h {
			t.Errorf("%s: got %dx%d, want %dx%d", name, w, h, c.w, c.h)
		}
	}
}

func TestIsKeyframe(t *testing.T) {
	if !IsKeyframe([]byte{0, 0, 0, 1, 0x65, 1, 2}) || IsKeyframe([]byte{0, 0, 0, 1, 0x41, 1, 2}) {
		t.Fatal("IDR and non-IDR slices are told apart wrongly")
	}
}

func TestParsePictureReadsTheColourCoding(t *testing.T) {
	for name, c := range map[string]struct {
		au   string
		want Colour
	}{
		"tagged BT.709 limited":   {"000000010910000000016742c01fd9005005bb016a04040280000003008000001e078c19240000000168cb83", Colour{native.BT709, false}},
		"tagged BT.601 full":      {"000000010910000000016742c01ed900a02ff97016e04040c8000003000800000301e078b172400000000168", Colour{native.BT601, true}},
		"untagged HD is BT.709":   {"000000010910000000016742c01fd9005005bb0110000003001000000300a0f1832480", Colour{native.BT709, false}},
		"untagged SD is BT.601":   {"000000010910000000016742c016d900a02ff970110000030001000003000a0f162e48", Colour{native.BT601, false}},
		"untagged 1080p is 709":   {"000000010910000000016742c028d900780227e5c044000003000400000300283c60c920", Colour{native.BT709, false}},
		"high profile untagged":   {"0000000109100000000167640016acd940a02ff970110000030001000003000a0f162d96", Colour{native.BT601, false}},
		"high 180p untagged SD":   {"000000010910000000016764000cacd941419f9f0110000003001000000300a0f1429960", Colour{native.BT601, false}},
		"no parameter set at all": {"00000001091000000001419a", Colour{}},
	} {
		au, _ := hex.DecodeString(c.au)
		if got := ParsePicture(au).Colour; got != c.want {
			t.Errorf("%s: got %+v, want %+v", name, got, c.want)
		}
	}
}

func TestProfileLevelID(t *testing.T) {
	for name, c := range map[string]struct{ au, want string }{
		"constrained baseline 3.1":  {"000000010910000000016742c01fd9005005bb016a04040280000003008000001e078c19240000000168cb83", "42c01f"},
		"baseline 4.0 is mapped":    {"000000010910000000016742c028d900780227e5c044000003000400000300283c60c920", "42c01f"},
		"high 2.2 is mapped to 3.1": {"0000000109100000000167640016acd940a02ff970110000030001000003000a0f162d96", "64001f"},
		"no parameter set":          {"00000001091000000001419a", ""},
	} {
		au, _ := hex.DecodeString(c.au)
		if got := ProfileLevelID(au); got != c.want {
			t.Errorf("%s: got %q, want %q", name, got, c.want)
		}
	}
}
