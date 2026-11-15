//go:build linux

package native

// Where captured pictures meet the encoder. A source asks for the buffer of the stream's size (begin), fills it, and hands
// it back (commit): the picture is encoded at once, in the source's thread, so a source that is too fast for the encoder
// just sees the encoder's own dropping. Pictures that come faster than the stream's frame rate are skipped, and when the
// source goes quiet (a still screen sends nothing) the last picture is encoded again once a second.

import (
	"sync"
	"time"
)

type frameKind int

const (
	frameBGRA frameKind = iota
	frameNV12
)

const (
	captureRepeat      = time.Second
	captureMaxFailures = 100
)

// nv12Encoder is an encoder that takes pictures already in the stream's colour coding.
type nv12Encoder interface{ EncodeNV12(nv12 []byte) error }

type captureSink struct {
	enc     Encoder
	nv12enc nv12Encoder
	w, h    int
	matrix  int
	minGap  time.Duration
	onFail  func(error)

	mu       sync.Mutex
	closed   bool
	kind     frameKind
	have     bool
	nv12     []byte
	bgra     []byte
	last     time.Time
	idle     *time.Timer
	failures int
	failed   bool
}

func newCaptureSink(enc Encoder, w, h, fps, matrix int, onFail func(error)) *captureSink {
	s := &captureSink{enc: enc, w: w, h: h, matrix: matrix, onFail: onFail, minGap: time.Second / time.Duration(fps) * 3 / 4}
	s.nv12enc, _ = enc.(nv12Encoder)
	s.idle = time.AfterFunc(captureRepeat, s.repeat)
	return s
}

// begin locks the sink and returns the buffer to fill: w*h*4 bytes of BGRA or nv12Size(w, h) bytes of NV12. It returns nil,
// with nothing locked, when the sink is closed or the picture comes too soon after the last.
func (s *captureSink) begin(kind frameKind) []byte {
	s.mu.Lock()
	if s.closed || s.failed || time.Since(s.last) < s.minGap {
		s.mu.Unlock()
		return nil
	}
	s.kind = kind
	if kind == frameBGRA {
		if s.bgra == nil {
			s.bgra = make([]byte, s.w*s.h*4)
		}
		return s.bgra
	}
	if s.nv12 == nil {
		s.nv12 = make([]byte, nv12Size(s.w, s.h))
	}
	return s.nv12
}

// abort gives the buffer back without a picture in it.
func (s *captureSink) abort() { s.mu.Unlock() }

// commit encodes the picture in the buffer begin returned.
func (s *captureSink) commit() {
	s.have = true
	s.last = time.Now()
	s.encodeLast()
	s.idle.Reset(captureRepeat)
	s.mu.Unlock()
}

func (s *captureSink) encodeLast() {
	var err error
	switch {
	case s.kind == frameBGRA:
		err = s.enc.EncodeBGRA(s.bgra, s.w*4)
	case s.nv12enc != nil:
		err = s.nv12enc.EncodeNV12(s.nv12)
	default:
		if s.bgra == nil {
			s.bgra = make([]byte, s.w*s.h*4)
		}
		nv12ToBGRA(s.bgra, s.nv12, s.w, s.h, s.matrix)
		err = s.enc.EncodeBGRA(s.bgra, s.w*4)
	}
	if err == nil {
		s.failures = 0
		return
	}
	if s.failures++; s.failures >= captureMaxFailures && !s.failed {
		s.failed = true
		go s.onFail(err)
	}
}

func (s *captureSink) repeat() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || !s.have || s.failed {
		return
	}
	s.encodeLast()
	s.idle.Reset(captureRepeat)
}

// close stops the sink and the encoder behind it.
func (s *captureSink) close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.idle.Stop()
	s.mu.Unlock()
	s.enc.Close()
}

// nv12ToBGRA converts a tightly packed NV12 picture of the stream's coding for an encoder that only takes BGRA.
func nv12ToBGRA(dst, nv12 []byte, w, h, matrix int) {
	nv12ToRGBA(dst, nv12[:w*h], w, nv12[w*h:], w, w, h, matrix, false)
	for i := 0; i+3 < len(dst); i += 4 {
		dst[i], dst[i+2] = dst[i+2], dst[i]
	}
}

// streamSize is the size of the stream for a source of srcW by srcH: the height asked for, never above the source's, and
// the width that keeps the shape; both even.
func streamSize(srcW, srcH, wantH int) (w, h int) {
	h = min(wantH, srcH) &^ 1
	h = max(h, 2)
	w = (srcW*h + srcH/2) / srcH &^ 1
	return max(w, 2), h
}

// keyFrame asks the encoder for a key frame; it does not wait.
func (s *captureSink) keyFrame() { s.enc.KeyFrame() }
