package video

import "testing"

func TestFrameKeepsThePictureOnShowUntilTheNextIsComplete(t *testing.T) {
	var woken int
	f := NewFrame(func() { woken++ })
	if f.Copy(make([]byte, 16), 0) != 0 {
		t.Fatal("an empty frame has no version")
	}

	picture := func(w, h int, fill byte) {
		buf := f.target(w, h)
		for i := range buf {
			buf[i] = fill
		}
	}
	picture(2, 2, 7)
	if w, _ := f.Size(); w != 0 {
		t.Fatal("a picture being written must not be shown")
	}
	f.publish()
	picture(4, 2, 9)
	dst := make([]byte, 16)
	if v := f.Copy(dst, 0); v != 1 || dst[0] != 7 {
		t.Fatalf("version %d, first byte %d: the old picture should stay until the new one is complete", v, dst[0])
	}
	f.publish()

	dst = make([]byte, 32)
	if v := f.Copy(dst, 1); v != 2 || dst[31] != 9 {
		t.Fatalf("after a resize: version %d, last byte %d", v, dst[31])
	}
	if w, h := f.Size(); w != 4 || h != 2 {
		t.Fatalf("size %dx%d", w, h)
	}
	if f.Copy(dst, 2) != 2 || f.Copy(make([]byte, 4), 1) != 1 {
		t.Fatal("nothing is copied when the version is current or the destination is too small")
	}
	if woken != 2 {
		t.Fatalf("woke %d times for 2 pictures", woken)
	}
	f.Release()
	if w, _ := f.Size(); w != 0 {
		t.Fatal("release keeps the buffers")
	}
}
