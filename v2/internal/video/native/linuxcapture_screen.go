//go:build linux

package native

import (
	"errors"
	"sync"
	"sync/atomic"
)

// endNotifier tells the owner once that a capture ended by itself, and never after Close.
type endNotifier struct {
	once   sync.Once
	closed atomic.Bool
	fn     func(error)
}

func (n *endNotifier) call(err error) {
	if !n.closed.Load() {
		n.once.Do(func() { n.fn(err) })
	}
}

// portalScreen is a Wayland screen capture: the portal's choice of screen, PipeWire carrying it, the sink encoding it.
type portalScreen struct {
	cast   *portalCast
	stream *pwStream
	sink   *captureSink
	end    *endNotifier
	mode   string
}

func startPortalScreen(p CaptureParams, onAU func([]byte), onEnd func(error)) (Capture, error) {
	end := &endNotifier{fn: onEnd}
	cast, err := openPortalCast(p.Display)
	if err != nil {
		return nil, err
	}
	stream, f, err := startPipeWire(cast.fd, cast.node, p.FPS, end.call)
	if err != nil {
		cast.Close()
		return nil, err
	}
	if !knownVideoFormat(f.format) {
		stream.Close()
		cast.Close()
		return nil, errors.New("the desktop sends the screen in a picture format this client does not read")
	}
	dw, dh := streamSize(f.w, f.h, p.Height)
	enc, err := newEncoder(EncodeParams{Width: dw, Height: dh, FPS: p.FPS, BitrateKbps: p.BitrateKbps, Matrix: p.Matrix, Backend: p.Backend}, onAU)
	if err != nil {
		stream.Close()
		cast.Close()
		return nil, err
	}
	s := &portalScreen{cast: cast, stream: stream, end: end, mode: "pipewire+" + enc.Mode()}
	s.sink = newCaptureSink(enc, dw, dh, p.FPS, p.Matrix, end.call)
	stream.sink.Store(s.sink)
	cast.watch(func() { end.call(errors.New("the screen share was stopped")) })
	return s, nil
}

func (s *portalScreen) Mode() string { return s.mode }

func (s *portalScreen) KeyFrame() { s.sink.keyFrame() }

func (s *portalScreen) Close() {
	s.end.closed.Store(true)
	s.stream.Close()
	s.cast.Close()
	s.sink.close()
}
