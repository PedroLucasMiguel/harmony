//go:build windows

// Choosing and configuring the decoder transform: which one to try for a Backend setting, the media types, low delay, the
// Direct3D device for DXVA, and the events of an asynchronous hardware transform.
package native

import (
	"fmt"
)

const (
	candSoftware = iota // Microsoft's decoder on the CPU
	candDXVA            // Microsoft's decoder on a graphics adapter
	candMFT             // a vendor's hardware transform
)

type winCand struct {
	kind    int
	backend string
}

// winCandidates is what to try for a Backend setting, best first. The system decoder on the adapter goes before a vendor
// transform because it is the path every browser takes.
func winCandidates(backend string) ([]winCand, error) {
	software := winCand{kind: candSoftware, backend: Software}
	if backend == Software {
		return []winCand{software}, nil
	}
	var list []winCand
	for _, e := range decoderEntries() {
		if e.info.ID == Software || (backend != Auto && backend != e.info.ID) {
			continue
		}
		if e.dxva {
			list = append(list, winCand{candDXVA, e.info.ID})
		}
		if e.mft {
			list = append(list, winCand{candMFT, e.info.ID})
		}
	}
	if backend == Auto {
		return append(list, software), nil
	}
	if len(list) == 0 {
		return nil, fmt.Errorf("no %s H.264 decoder: install or update the graphics driver", backend)
	}
	return list, nil
}

// winMFT is one transform and what goes with it; its fields below the first group belong to the decoder goroutine.
type winMFT struct {
	cand    winCand
	t       mfTransform
	async   bool
	events  *winEvents
	mgr     mfDXGIManager
	dev     com
	credits int // inputs the transform will take now
	w, h    int // the size the input type was made for

	provides  bool // the transform allocates its output samples
	outSample mfSample
	typeTries int

	// the output picture: coded size, the visible part of it, and the row stride when the type says
	fw, fh, vw, vh, cx, cy int
	stride                 int

	fed, shown, errs int
	noTexture        bool // the pictures are in system memory, not Direct3D textures

	// call scratch, on the heap so that addresses handed to Windows stay put
	out    mftOutputDataBuffer
	status uint32
	info   mftOutputStreamInfo
	o      struct {
		buf, b2, scan uintptr
		pitch         int32
		contig        uint32
		ptr           uintptr
		max, cur      uint32
		area          mfVideoArea
		blob          uint32
		tex           uintptr
		desc          [11]uint32 // D3D11_TEXTURE2D_DESC: width, height, ...
	}
}

// open starts the first transform from cands[from] that works.
func (d *winDecoder) open(from, w, h int) bool {
	if w <= 0 || h <= 0 {
		w, h = 1280, 720
	}
	for i := from; i < len(d.cands); i++ {
		m, err := d.start(d.cands[i], w, h)
		if err != nil {
			d.lastError = err
			continue
		}
		d.ci, d.m, d.events = i, m, nil
		if m.events != nil {
			d.events = m.events.ch
		}
		return true
	}
	return false
}

func (d *winDecoder) closeMFT() {
	if d.m != nil {
		d.m.close()
	}
	d.m, d.events = nil, nil
}

func (d *winDecoder) start(c winCand, w, h int) (m *winMFT, err error) {
	m = &winMFT{cand: c, w: w, h: h}
	defer func() {
		if err != nil {
			m.close()
			m = nil
		}
	}()
	if c.kind == candMFT {
		var obj com
		if obj, err = activateHardwareDecoder(c.backend); err != nil {
			return
		}
		m.t = mfTransform{obj}
	} else {
		var obj com
		if obj, err = coCreateInstance(&clsidMSH264DecoderMFT, &iidIMFTransform); err != nil {
			err = fmt.Errorf("the Microsoft H.264 decoder is not there (Windows N editions need the Media Feature Pack): %w", err)
			return
		}
		m.t = mfTransform{obj}
	}
	attrs, ok := m.t.attributes()
	if ok {
		defer attrs.release()
		if v, found, _ := attrs.getUINT32(&mfTransformAsync); found && v == 1 {
			m.async = true
			if err = attrs.setUINT32(&mfTransformAsyncUnlk, 1); err != nil {
				return
			}
		}
		attrs.setUINT32(&mfLowLatency, 1)
	}
	if c.kind == candDXVA {
		if err = m.attachDevice(c.backend); err != nil {
			return
		}
	}
	in, err := mfCreateMediaType()
	if err != nil {
		return
	}
	defer in.release()
	if err = in.setGUID(&mfMTMajorType, &guidMediaTypeVideo); err != nil {
		return
	}
	if err = in.setGUID(&mfMTSubtype, &guidVideoH264); err != nil {
		return
	}
	if err = in.setSize(w, h); err != nil {
		return
	}
	if err = m.t.setInputType(in); err != nil {
		return
	}
	d.negotiateOutput(m)
	m.t.processMessage(mftMsgBeginStream, 0)
	m.t.processMessage(mftMsgStartStream, 0)
	if m.async {
		var gen com
		if gen, err = m.t.queryInterface(&iidIMFMediaEventGen); err != nil {
			return
		}
		m.events = newWinEvents(mfEventGenerator{gen})
		if hr := m.events.start(); hr.failed() {
			err = hr.err("BeginGetEvent")
			return
		}
	} else {
		m.credits = 1
	}
	return
}

// attachDevice gives the transform a Direct3D device of the vendor's adapter, so that it decodes with the graphics hardware.
func (m *winMFT) attachDevice(backend string) error {
	dev, err := winDeviceFor(backend)
	if err != nil {
		return err
	}
	m.dev = dev
	mgr, token, err := mfCreateDXGIDeviceManager()
	if err != nil {
		return err
	}
	m.mgr = mgr
	if err = mgr.resetDevice(dev, token); err != nil {
		return err
	}
	if attrs, ok := m.t.attributes(); ok {
		v, found, _ := attrs.getUINT32(&mfSAD3D11Aware)
		attrs.release()
		if found && v == 0 {
			return fmt.Errorf("the decoder does not use Direct3D 11")
		}
	}
	return m.t.processMessage(mftMsgSetD3DMgr, uintptr(mgr.com)).err("SET_D3D_MANAGER")
}

func (m *winMFT) close() {
	if m.events != nil {
		m.events.closed.Store(true)
	}
	if m.t.com != 0 {
		m.t.processMessage(mftMsgEndStream, 0)
	}
	if m.events != nil {
		m.events.gen.release()
	}
	m.outSample.release()
	m.t.release()
	m.mgr.release()
	m.dev.release()
}

// activateHardwareDecoder makes the best hardware transform of a vendor.
func activateHardwareDecoder(backend string) (com, error) {
	var obj com
	var err error = fmt.Errorf("no %s hardware decoder transform", backend)
	for _, v := range mftHardware(&guidCategoryDec, &guidVideoH264) {
		if v.backend == backend && obj == 0 {
			obj, err = v.activate.activate(&iidIMFTransform)
		}
		v.activate.release()
	}
	return obj, err
}
