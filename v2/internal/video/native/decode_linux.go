//go:build linux

package native

// H.264 decode on Linux through VA-API (AMD and Intel graphics; NVIDIA has its own decoder). The stream's headers are
// read here in Go and the hardware decodes the slices: this file is the picture assembly and output, linuxdecode_*.go
// hold the parameter sets, slice headers, picture buffer and VA-API calls.

import (
	"fmt"
	"log"
	"sync"
	"sync/atomic"
)

func newDecoder(p DecodeParams, on func([]byte, int, int)) (Decoder, error) {
	switch p.Backend {
	case NVIDIA:
		return newNVDecoder(p, on)
	case AMD:
		return newVADecoder(p, on, pciVendorAMD)
	case Intel:
		return newVADecoder(p, on, pciVendorIntel)
	case Auto:
		tried := false
		var firstErr error
		for _, b := range listDecoders() {
			var dec Decoder
			var err error
			switch b.ID {
			case NVIDIA:
				dec, err = newNVDecoder(p, on)
			case AMD:
				dec, err = newVADecoder(p, on, pciVendorAMD)
			case Intel:
				dec, err = newVADecoder(p, on, pciVendorIntel)
			default:
				continue
			}
			if err == nil {
				return dec, nil
			}
			if firstErr == nil {
				firstErr = err
			}
			tried = true
		}
		if tried {
			return nil, firstErr
		}
		return newVADecoder(p, on, 0)
	}
	return nil, fmt.Errorf("unknown decoder %q", p.Backend)
}

// openDecodeDisplay opens the render node of the vendor (0: any) whose driver decodes H.264.
func openDecodeDisplay(vendor uint32) (*vaDisplay, error) {
	var first error
	for _, profile := range []int32{vaProfileH264High, vaProfileH264Main, vaProfileH264ConstrainedBaseline} {
		d, err := openVADisplay(vendor, profile, vaEntrypointVLD)
		if err == nil {
			return d, nil
		}
		if first == nil {
			first = err
		}
	}
	return nil, first
}

const vdQueueLen = 8

type vaDecoder struct {
	p    DecodeParams
	on   func([]byte, int, int)
	disp *vaDisplay
	asm  *vdAssembler

	queue chan []byte
	pool  chan []byte
	stop  chan struct{}
	done  chan struct{}
	once  sync.Once
	lost  atomic.Bool

	// owned by the decoder goroutine
	sess   *vdSession
	rgba   []byte
	scaler vdScaler
	mapped vdMapped
}

func newVADecoder(p DecodeParams, on func([]byte, int, int), vendor uint32) (Decoder, error) {
	disp, err := openDecodeDisplay(vendor)
	if err != nil {
		return nil, err
	}
	d := &vaDecoder{p: p, on: on, disp: disp,
		queue: make(chan []byte, vdQueueLen), pool: make(chan []byte, vdQueueLen+2),
		stop: make(chan struct{}), done: make(chan struct{})}
	d.asm = newVDAssembler(d, func(msg string) { log.Print("vaapi decoder: ", msg) })
	go d.run()
	return d, nil
}

func (d *vaDecoder) Mode() string { return "vaapi" }

func (d *vaDecoder) Write(au []byte) bool {
	var buf []byte
	select {
	case buf = <-d.pool:
	default:
	}
	buf = append(buf[:0], au...)
	select {
	case d.queue <- buf:
	default:
		d.lost.Store(true)
		d.recycle(buf)
	}
	return d.asm.needKey.Load() || d.lost.Load()
}

func (d *vaDecoder) recycle(buf []byte) {
	select {
	case d.pool <- buf:
	default:
	}
}

func (d *vaDecoder) Close() {
	d.once.Do(func() {
		close(d.stop)
		<-d.done
		if d.sess != nil {
			d.sess.Close()
		}
		d.disp.Close()
	})
}

func (d *vaDecoder) run() {
	defer close(d.done)
	for {
		select {
		case <-d.stop:
			return
		case au := <-d.queue:
			if d.lost.Swap(false) {
				d.asm.lose()
			}
			d.asm.write(au)
			d.recycle(au)
		}
	}
}

func (d *vaDecoder) open(sps *vdSPS, surfaces int) ([]vaSurfaceID, error) {
	if d.sess != nil {
		d.sess.Close()
		d.sess = nil
	}
	sess, err := openVDSession(d.disp, sps, surfaces)
	if err != nil {
		return nil, err
	}
	d.sess = sess
	return sess.surfaces, nil
}

func (d *vaDecoder) decode(target vaSurfaceID, pic *vaPictureParameterBufferH264, iq *vaIQMatrixBufferH264, sl *vdSlices) error {
	return d.sess.submit(target, pic, iq, sl)
}

func (d *vaDecoder) behind() bool { return len(d.queue) >= 2 }

// vdColour is the matrix and range the stream says it is coded with, or else what the caller says.
func vdColour(sps *vdSPS, p DecodeParams) (int, bool) {
	matrix, full := p.Matrix, p.Full
	if sps.signalType {
		full = sps.fullRange
		switch sps.matrix {
		case 1, 9, 10:
			matrix = BT709
		case 5, 6:
			matrix = BT601
		}
	}
	if matrix != BT709 && matrix != BT601 {
		matrix = BT601
		if sps.outWidth() > 640 {
			matrix = BT709
		}
	}
	return matrix, full
}

// show reads the picture back, shrinks it to the size asked for and hands it on.
func (d *vaDecoder) show(sps *vdSPS, surface vaSurfaceID) error {
	sw, sh := sps.outWidth(), sps.outHeight()
	dw, dh := vdFit(sw, sh, d.p.Width, d.p.Height)
	m := &d.mapped
	if err := d.sess.readback(surface, m); err != nil {
		return err
	}
	if need := dw * dh * 4; cap(d.rgba) < need {
		d.rgba = make([]byte, need)
	}
	out := d.rgba[:dw*dh*4]
	matrix, full := vdColour(sps, d.p)
	d.scaler.convert(out, m.y, m.yPitch, m.uv, m.uvPit, sps.cropL, sps.cropT, sw, sh, dw, dh, matrix, full)
	d.sess.unmap(m)
	d.on(out, dw, dh)
	return nil
}
