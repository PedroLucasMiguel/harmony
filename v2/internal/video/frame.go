package video

import "sync"

// Frame is the latest decoded picture of one stream, RGBA, in two buffers that swap when a picture is complete.
// A viewer asks for it by version, so a picture nobody asked about again costs nothing; versions start at 1.
type Frame struct {
	mu        sync.Mutex
	w, h      int
	front     []byte
	version   uint64
	back      []byte
	bw, bh    int
	onPicture func()
	gpu       gpuState
}

// NewFrame makes an empty frame; onPicture is called, from the decoder's goroutine, after each new picture.
func NewFrame(onPicture func()) *Frame { return &Frame{onPicture: onPicture} }

// Size is the size of the latest picture; 0, 0 before the first.
func (f *Frame) Size() (w, h int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.w, f.h
}

// Version is how many pictures have been made.
func (f *Frame) Version() uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.version
}

// Copy puts the latest picture in dst and returns its version, or returns have and copies nothing when the picture is
// the one the caller already has or dst is smaller than w*h*4.
func (f *Frame) Copy(dst []byte, have uint64) uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.version == have || len(dst) < len(f.front) {
		return have
	}
	copy(dst, f.front)
	return f.version
}

// View is Copy without the copy: fn sees the latest picture in place, for as long as it runs (keep it short, the
// decoder waits for it only when it finishes the next picture). fn is not called when nothing is new.
func (f *Frame) View(have uint64, fn func(pix []byte, w, h int)) uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.version == have || len(f.front) == 0 {
		return have
	}
	fn(f.front, f.w, f.h)
	return f.version
}

// target is where the next picture of size w by h is to be written. The picture on show stays until it is complete.
func (f *Frame) target(w, h int) []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.bw != w || f.bh != h {
		f.back, f.bw, f.bh = make([]byte, w*h*4), w, h
	}
	return f.back
}

func (f *Frame) publish() {
	f.mu.Lock()
	f.front, f.back = f.back, f.front
	f.w, f.h, f.bw, f.bh = f.bw, f.bh, f.w, f.h
	f.version++
	f.mu.Unlock()
	if f.onPicture != nil {
		f.onPicture()
	}
}

// Release gives the buffers back; the next picture allocates them again. Call it when the stream is not decoding.
func (f *Frame) Release() {
	f.mu.Lock()
	f.front, f.back, f.w, f.h, f.bw, f.bh = nil, nil, 0, 0, 0, 0
	f.gpu.dead = true
	pending := f.gpu.pending
	f.gpu.pending = nil
	f.mu.Unlock()
	if pending != nil {
		pending.Release()
	}
}
