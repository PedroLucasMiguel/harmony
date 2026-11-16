//go:build windows

// H.264 decoding on Windows through a Media Foundation transform: the system decoder on the graphics hardware (DXVA) where
// there is some, a vendor's hardware transform, or the software decoder. Access units are queued by Write and decoded, turned
// into RGBA and delivered by one goroutine of the decoder.
package native

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
)

// winQueueLen is how many access units may wait for the decoder; more than that and the decoder is behind: they are dropped
// and the next key frame is asked for.
const winQueueLen = 8

type winAU struct {
	data []byte
	idr  bool
}

type winDecoder struct {
	p         DecodeParams
	onPicture func(rgba []byte, w, h int)
	cands     []winCand

	queue chan *winAU
	free  chan *winAU
	done  chan struct{}
	exit  chan struct{}

	needKey   atomic.Bool
	closed    atomic.Bool
	closeOnce sync.Once

	// owned by the decoder goroutine
	ci        int
	m         *winMFT
	events    <-chan uint32
	skipping  bool
	sps       winSPS
	haveSPS   bool
	ts        int64
	scaler    *winScaler
	rgba, sy  []byte
	suv       []byte
	lastError error

	gpu      *winGPU
	gpuOff   bool
	gpuFails int
	gpuUsed  atomic.Bool
}

func newDecoder(p DecodeParams, onPicture func([]byte, int, int)) (Decoder, error) {
	d := &winDecoder{
		p: p, onPicture: onPicture,
		queue:  make(chan *winAU, winQueueLen),
		free:   make(chan *winAU, winQueueLen),
		done:   make(chan struct{}),
		exit:   make(chan struct{}),
		scaler: newWinScaler(),
	}
	for i := 0; i < winQueueLen; i++ {
		d.free <- &winAU{}
	}
	d.needKey.Store(true)
	ready := make(chan error, 1)
	go d.run(ready)
	if err := <-ready; err != nil {
		return nil, err
	}
	return d, nil
}

func (d *winDecoder) Mode() string {
	if d.gpuUsed.Load() {
		return "mediafoundation (gpu scaling)"
	}
	return "mediafoundation"
}

func (d *winDecoder) Write(au []byte) (needKeyframe bool) {
	if d.closed.Load() {
		return false
	}
	idr := winIsIDR(au)
	if d.needKey.Load() {
		if !idr {
			return true
		}
		d.needKey.Store(false)
	}
	var b *winAU
	select {
	case b = <-d.free:
	default:
		d.dropQueued()
		if !idr {
			d.needKey.Store(true)
			return true
		}
		select {
		case b = <-d.free:
		default:
			d.needKey.Store(true)
			return true
		}
	}
	b.data = append(b.data[:0], au...)
	b.idr = idr
	d.queue <- b
	return false
}

func (d *winDecoder) dropQueued() {
	for {
		select {
		case b := <-d.queue:
			d.free <- b
		default:
			return
		}
	}
}

// Close ends the decoder and waits for its goroutine; no picture is delivered after it returns. It must not be called from
// onPicture.
func (d *winDecoder) Close() {
	d.closeOnce.Do(func() {
		d.closed.Store(true)
		close(d.done)
		<-d.exit
	})
}

// run is the decoder goroutine: it owns the Media Foundation transform from creation to release.
func (d *winDecoder) run(ready chan<- error) {
	defer close(d.exit)
	end, err := comSession()
	if err != nil {
		ready <- err
		return
	}
	defer end()
	defer func() {
		if d.gpu != nil {
			d.gpu.drop()
		}
	}()
	if d.cands, err = winCandidates(d.p.Backend); err != nil {
		ready <- err
		return
	}
	if !d.open(0, d.p.Width, d.p.Height) {
		ready <- fmt.Errorf("no H.264 decoder could be started: %w", errors.Join(d.lastError, ErrUnsupported))
		return
	}
	ready <- nil
	defer d.closeMFT()
	for {
		var in <-chan *winAU
		if d.m == nil || d.m.credits > 0 {
			in = d.queue
		}
		select {
		case <-d.done:
			return
		case b := <-in:
			d.handle(b)
			d.free <- b
		case t := <-d.events:
			d.onEvent(t)
		}
	}
}
