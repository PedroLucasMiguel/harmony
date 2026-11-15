//go:build windows

// Camera capture through the Media Foundation source reader. The reader picks the camera's mode (size, rate, format), turns
// whatever the camera makes (NV12, YUY2, motion JPEG) into 32 bit RGB, and each picture goes to the encoder, scaled on the
// CPU when the camera's size is not the stream's.
package native

import (
	"errors"
	"fmt"
	"syscall"
	"time"
	"unsafe"
)

var (
	dllMf          = syscall.NewLazyDLL("mf.dll")
	dllMfReadWrite = syscall.NewLazyDLL("mfreadwrite.dll")

	procMFEnumDeviceSources                 = dllMf.NewProc("MFEnumDeviceSources")
	procMFCreateSourceReaderFromMediaSource = dllMfReadWrite.NewProc("MFCreateSourceReaderFromMediaSource")
)

const (
	readerFlagError       = 0x1
	readerFlagEndOfStream = 0x2
	readerFlagTypeChanged = 0x20 // MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED
	cameraFirstFrameWait  = 10 * time.Second
)

// mfEnumVideoCaptureDevices lists the cameras, the default one first. The activates are the caller's to release.
func mfEnumVideoCaptureDevices() ([]mfActivate, error) {
	attrs, err := mfCreateAttributes(1)
	if err != nil {
		return nil, err
	}
	defer attrs.release()
	if err := attrs.setGUID(&weMFDevSourceType, &weMFDevSourceVidcap); err != nil {
		return nil, err
	}
	var arr uintptr
	var n uint32
	if hr := callProc(procMFEnumDeviceSources, uintptr(attrs.com), uintptr(unsafe.Pointer(&arr)), uintptr(unsafe.Pointer(&n))); hr.failed() {
		return nil, hr.err("MFEnumDeviceSources")
	}
	list := make([]mfActivate, n)
	for i := range list {
		list[i] = mfActivate{mfAttributes{com(peek(arr + uintptr(i)*ptrSize))}}
	}
	coTaskMemFree(arr)
	return list, nil
}

// camMode is one mode a camera offers.
type camMode struct {
	index int
	w, h  int
	fps   float64
	sub   guid
}

// rank orders modes by how well they suit the stream (smaller is better): enough lines but not many more, enough frames a
// second but not many more, and formats that need no decoding before those that do.
func (m camMode) rank(wantH, wantFPS int) [3]int {
	lines := m.h - wantH
	if lines < 0 {
		lines = 1<<20 - lines
	}
	rate := int(m.fps*10) - wantFPS*10
	if rate < 0 {
		rate = 1<<20 - rate
	}
	format := 3
	switch m.sub {
	case guidVideoNV12:
		format = 0
	case guidVideoYUY2:
		format = 1
	case guidVideoRGB32:
		format = 2
	case guidVideoMJPG:
		format = 4
	}
	return [3]int{lines, rate, format}
}

func less3(a, b [3]int) bool {
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

// mfSourceReader is an IMFSourceReader.
type mfSourceReader struct{ com }

func (r mfSourceReader) nativeType(index int) (mfMediaType, hresult) {
	out := new(uintptr)
	hr := r.call(5, mfSourceReaderFirstVideo, uintptr(index), uintptr(unsafe.Pointer(out)))
	if hr.failed() {
		return mfMediaType{}, hr
	}
	return mfMediaType{mfAttributes{com(*out)}}, hr
}

func (r mfSourceReader) setCurrentType(mt mfMediaType) hresult {
	return r.call(7, mfSourceReaderFirstVideo, 0, uintptr(mt.com))
}

func (r mfSourceReader) currentType() (mfMediaType, error) {
	out := new(uintptr)
	if hr := r.call(6, mfSourceReaderFirstVideo, uintptr(unsafe.Pointer(out))); hr.failed() {
		return mfMediaType{}, hr.err("GetCurrentMediaType")
	}
	return mfMediaType{mfAttributes{com(*out)}}, nil
}

// camera is one open camera.
type camera struct {
	c        *winCapture
	p        CaptureParams
	act      mfActivate
	source   com
	reader   mfSourceReader
	enc      *mftEncoder
	name     string
	srcW     int
	srcH     int
	w, h     int
	stride   int // from the type; negative when the rows are stored bottom first
	scaler   *bgraScaler
	scaled   []byte
	interval int64 // 100 ns between pictures
	lastTS   int64

	// scratch for the calls of every picture: fields of a heap object, so nothing is allocated per picture
	flags, streamFlags uint32
	ts                 int64
	sample, bufp, b2d  uintptr
	scan0              uintptr
	pitch              int32
	lockP              uintptr
	lockMax, lockCur   uint32
}

func (cam *camera) release() {
	if cam.enc != nil {
		cam.c.enc.Store(nil)
		cam.enc.Close()
	}
	cam.reader.release()
	if cam.act.com != 0 {
		cam.act.shutdownObject()
		cam.act.release()
	}
	cam.source.release()
}

func cameraAccessError(err error) error {
	if errors.Is(err, hrAccessDenied) {
		return fmt.Errorf("the camera is blocked: allow desktop apps to use it in Windows Settings > Privacy & security > Camera (%w)", err)
	}
	return err
}

func (cam *camera) open() error {
	if err := cam.openReader(); err != nil {
		return err
	}
	if err := cam.chooseMode(); err != nil {
		return err
	}
	return cam.startEncoder()
}

// openReader activates the camera and makes the source reader over it.
func (cam *camera) openReader() error {
	acts, err := mfEnumVideoCaptureDevices()
	if err != nil {
		return err
	}
	if len(acts) == 0 {
		return errors.New("no camera found")
	}
	for _, a := range acts {
		id, _, _ := a.getString(&weMFDevSymbolicLink)
		if cam.act.com == 0 && (cam.p.CameraID == "" || id == cam.p.CameraID) {
			cam.act = a
			cam.name, _, _ = a.getString(&weMFDevFriendlyName)
		} else {
			a.release()
		}
	}
	if cam.act.com == 0 {
		return fmt.Errorf("camera %q is not connected", cam.p.CameraID)
	}
	if cam.source, err = cam.act.activate(&iidIMFMediaSource); err != nil {
		return cameraAccessError(err)
	}
	attrs, err := mfCreateAttributes(2)
	if err != nil {
		return err
	}
	defer attrs.release()
	attrs.setUINT32(&weMFReaderVideoProc, 1)
	attrs.setUINT32(&weMFReaderDisconnect, 1)
	var rd uintptr
	if hr := callProc(procMFCreateSourceReaderFromMediaSource, uintptr(cam.source), uintptr(attrs.com), uintptr(unsafe.Pointer(&rd))); hr.failed() {
		return cameraAccessError(hr.err("MFCreateSourceReaderFromMediaSource"))
	}
	cam.reader = mfSourceReader{com(rd)}
	return nil
}

// chooseMode selects the camera's best mode and asks the reader for RGB32 pictures of it.
func (cam *camera) chooseMode() error {
	var best camMode
	var bestType mfMediaType
	found := false
	for i := 0; ; i++ {
		mt, hr := cam.reader.nativeType(i)
		if hr.failed() {
			break
		}
		w, h, ok := mt.size()
		rate, _, _ := mt.getUINT64(&mfMTFrameRate)
		sub, _ := mt.subtype()
		if ok && w > 0 && h > 0 {
			m := camMode{index: i, w: w, h: h, fps: 30, sub: sub}
			if den := uint32(rate); den != 0 {
				m.fps = float64(rate>>32) / float64(den)
			}
			if !found || less3(m.rank(cam.p.Height, cam.p.FPS), best.rank(cam.p.Height, cam.p.FPS)) {
				if found {
					bestType.release()
				}
				best, bestType, found = m, mt, true
				continue
			}
		}
		mt.release()
	}
	if !found {
		return errors.New("the camera offers no video mode")
	}
	defer bestType.release()
	if hr := cam.reader.setCurrentType(bestType); hr.failed() {
		return cameraAccessError(hr.err("SetCurrentMediaType(camera mode)"))
	}
	out, err := mfCreateMediaType()
	if err != nil {
		return err
	}
	defer out.release()
	rate, _, _ := bestType.getUINT64(&mfMTFrameRate)
	for _, step := range []func() error{
		func() error { return out.setGUID(&mfMTMajorType, &guidMediaTypeVideo) },
		func() error { return out.setGUID(&mfMTSubtype, &guidVideoRGB32) },
		func() error { return out.setSize(best.w, best.h) },
		func() error { return out.setUINT64(&mfMTFrameRate, rate) },
		func() error { return out.setUINT32(&mfMTInterlaceMode, mfInterlaceProgressive) },
	} {
		if err := step(); err != nil {
			return err
		}
	}
	if hr := cam.reader.setCurrentType(out); hr.failed() {
		return hr.err("SetCurrentMediaType(RGB32)")
	}
	return cam.readCurrentType()
}

// readCurrentType learns the picture size and row layout the reader delivers.
func (cam *camera) readCurrentType() error {
	cur, err := cam.reader.currentType()
	if err != nil {
		return err
	}
	defer cur.release()
	w, h, ok := cur.size()
	if !ok || w < 2 || h < 2 {
		return errors.New("the camera reports no picture size")
	}
	if cam.enc != nil && (w != cam.srcW || h != cam.srcH) {
		return errors.New("the camera changed its picture size")
	}
	cam.srcW, cam.srcH = w, h
	cam.stride = -w * 4 // RGB32 is stored bottom first unless the type says otherwise
	if v, ok, _ := cur.getUINT32(&mfMTDefaultStride); ok {
		cam.stride = int(int32(v))
	}
	cam.interval = int64(time.Second/time.Duration(cam.p.FPS)) / 100 * 8 / 10
	return nil
}

func (cam *camera) startEncoder() error {
	cam.w, cam.h = scaledSize(cam.srcW, cam.srcH, cam.p.Height)
	if cam.w != cam.srcW || cam.h != cam.srcH {
		cam.scaler = newBGRAScaler(cam.srcW, cam.srcH, cam.w, cam.h)
		cam.scaled = make([]byte, cam.w*cam.h*4)
	}
	var err error
	cam.enc, err = newMFTEncoder(EncodeParams{Width: cam.w, Height: cam.h, FPS: cam.p.FPS, BitrateKbps: cam.p.BitrateKbps,
		Matrix: cam.p.Matrix, Backend: cam.p.Backend}, cam.c.deliver, nil)
	if err == nil {
		cam.c.enc.Store(cam.enc)
	}
	return err
}

// next reads one picture and encodes it; first reports whether a picture came. A camera that stops ends the capture.
func (cam *camera) next() (got bool, err error) {
	cam.sample = 0
	hr := cam.reader.call(9, mfSourceReaderFirstVideo, 0, uintptr(unsafe.Pointer(&cam.flags)), uintptr(unsafe.Pointer(&cam.streamFlags)),
		uintptr(unsafe.Pointer(&cam.ts)), uintptr(unsafe.Pointer(&cam.sample))) // IMFSourceReader::ReadSample
	if hr.failed() {
		return false, cameraAccessError(hr.err("ReadSample"))
	}
	if cam.streamFlags&(readerFlagError|readerFlagEndOfStream) != 0 {
		return false, errors.New("the camera stopped sending pictures (unplugged, or taken by another program)")
	}
	if cam.streamFlags&readerFlagTypeChanged != 0 {
		if err := cam.readCurrentType(); err != nil {
			return false, err
		}
	}
	if cam.sample == 0 {
		return false, nil
	}
	sample := com(cam.sample)
	defer sample.release()
	if cam.lastTS != 0 && cam.ts-cam.lastTS < cam.interval {
		return true, nil
	}
	cam.lastTS = cam.ts
	return true, cam.encode(sample)
}

// encode hands the sample's pixels to the encoder, locking the buffer the way that gives the row order too.
func (cam *camera) encode(sample com) error {
	if hr := sample.call(41, uintptr(unsafe.Pointer(&cam.bufp))); hr.failed() { // ConvertToContiguousBuffer
		return hr.err("ConvertToContiguousBuffer")
	}
	buf := com(cam.bufp)
	defer buf.release()
	var pix []byte
	stride := cam.stride
	if hr := buf.call(0, iidIMF2DBuffer.p(), uintptr(unsafe.Pointer(&cam.b2d))); hr >= 0 {
		b2d := com(cam.b2d)
		defer b2d.release()
		if hr := b2d.call(3, uintptr(unsafe.Pointer(&cam.scan0)), uintptr(unsafe.Pointer(&cam.pitch))); hr.failed() { // Lock2D
			return hr.err("Lock2D")
		}
		defer b2d.call(4) // Unlock2D
		stride = int(cam.pitch)
		if stride >= 0 {
			pix = bytesAt(cam.scan0, stride*cam.srcH)
		} else {
			pix = bytesAt(cam.scan0+uintptr(stride*(cam.srcH-1)), -stride*cam.srcH)
		}
	} else {
		if hr := buf.call(3, uintptr(unsafe.Pointer(&cam.lockP)), uintptr(unsafe.Pointer(&cam.lockMax)), uintptr(unsafe.Pointer(&cam.lockCur))); hr.failed() {
			return hr.err("IMFMediaBuffer::Lock")
		}
		defer buf.call(4)
		pix = bytesAt(cam.lockP, int(cam.lockCur))
	}
	if len(pix) < max(stride, -stride)*(cam.srcH-1)+cam.srcW*4 {
		return fmt.Errorf("camera picture of %d bytes is too small for %dx%d", len(pix), cam.srcW, cam.srcH)
	}
	if cam.scaler != nil {
		cam.scaler.scale(cam.scaled, pix, stride)
		return cam.enc.EncodeBGRA(cam.scaled, cam.w*4)
	}
	return cam.enc.EncodeBGRA(pix, stride)
}

func (c *winCapture) runCamera(p CaptureParams, onAU func([]byte), ready chan<- error) {
	defer close(c.done)
	end, err := comSession()
	if err != nil {
		ready <- err
		return
	}
	defer end()
	c.deliver = onAU
	cam := &camera{c: c, p: p}
	defer cam.release()
	if err := cam.open(); err != nil {
		ready <- err
		return
	}
	c.mode = fmt.Sprintf("mediafoundation camera %s, %s", cam.name, cam.enc.Mode())
	started := false
	for !c.closed.Load() {
		got, err := cam.next()
		if err != nil {
			if !started {
				ready <- err
			} else {
				c.finish(err)
			}
			return
		}
		if got && !started {
			started = true
			ready <- nil
		}
	}
	if !started {
		ready <- errEncoderClosed
	}
}
