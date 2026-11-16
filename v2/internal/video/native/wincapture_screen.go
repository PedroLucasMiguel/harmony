//go:build windows

// Screen capture with DXGI Desktop Duplication. The desktop picture stays in the graphics memory: the video processor
// scales it there to the size of the stream, and only that small picture is read back for the encoder. When the display
// changes (resolution, secure desktop) the capture is built again and the stream continues with a new key frame.
package native

import (
	"errors"
	"fmt"
	"time"
	"unsafe"
)

const (
	dxgiWaitTimeout     = hresult(-0x80000000 + 0x087A0027) // DXGI_ERROR_WAIT_TIMEOUT 0x887A0027
	dxgiAccessLost      = hresult(-0x80000000 + 0x087A0026) // DXGI_ERROR_ACCESS_LOST 0x887A0026
	dxgiNotAvailable    = hresult(-0x80000000 + 0x087A0022) // DXGI_ERROR_NOT_CURRENTLY_AVAILABLE 0x887A0022
	dxgiUnsupported     = hresult(-0x80000000 + 0x087A0004) // DXGI_ERROR_UNSUPPORTED 0x887A0004
	dxgiDeviceRemoved   = hresult(-0x80000000 + 0x087A0005) // DXGI_ERROR_DEVICE_REMOVED 0x887A0005
	dxgiSessionGone     = hresult(-0x80000000 + 0x087A0028) // DXGI_ERROR_SESSION_DISCONNECTED 0x887A0028
	hrAccessDenied      = hresult(-0x80000000 + 0x00070005) // E_ACCESSDENIED 0x80070005
	dxgiFormatBGRA8     = 87
	d3dBindShaderRes    = 0x8
	d3dBindRenderTarget = 0x20
	d3dUsageStaging     = 3
	d3dCPUAccessRead    = 0x20000
	d3dMapRead          = 1
	vpDimensionTexture2 = 1

	screenIdleResend  = time.Second
	screenMaxWait     = 500 * time.Millisecond
	screenRetryEvery  = 250 * time.Millisecond
	screenRetryGiveUp = 40
	screenStableAfter = 5 * time.Second
)

var errRebuildScreen = errors.New("display changed")

// screenOutput is a monitor of a graphics adapter.
type screenOutput struct {
	adapter, output com
	primary         bool
}

// pickOutput finds the monitor with the index of CaptureParams.Display: the primary one is 0, the others follow in the
// order DXGI lists them.
func pickOutput(display int) (adapter, output com, err error) {
	factory := new(uintptr)
	if hr := callProc(procCreateDXGIFactory1, iidIDXGIFactory1.p(), uintptr(unsafe.Pointer(factory))); hr.failed() {
		return 0, 0, hr.err("CreateDXGIFactory1")
	}
	f := com(*factory)
	defer f.release()
	var list []screenOutput
	for i := 0; ; i++ {
		var ad uintptr
		if hr := f.call(12, uintptr(i), uintptr(unsafe.Pointer(&ad))); hr.failed() { // IDXGIFactory1::EnumAdapters1
			break
		}
		for j := 0; ; j++ {
			var out uintptr
			if hr := com(ad).call(7, uintptr(j), uintptr(unsafe.Pointer(&out))); hr.failed() { // IDXGIAdapter::EnumOutputs
				break
			}
			var desc dxgiOutputDesc
			if hr := com(out).call(7, uintptr(unsafe.Pointer(&desc))); hr.failed() || desc.attached == 0 {
				com(out).release()
				continue
			}
			com(ad).addRef()
			so := screenOutput{adapter: com(ad), output: com(out), primary: desc.left == 0 && desc.top == 0}
			if so.primary {
				list = append([]screenOutput{so}, list...)
			} else {
				list = append(list, so)
			}
		}
		com(ad).release()
	}
	defer func() {
		for i, so := range list {
			if i != display {
				so.adapter.release()
				so.output.release()
			}
		}
	}()
	if display < 0 || display >= len(list) {
		return 0, 0, fmt.Errorf("screen %d does not exist: this computer has %d", display, len(list))
	}
	return list[display].adapter, list[display].output, nil
}

// dxgiScreen is one built capture: the device, the duplication, the textures and the encoder.
type dxgiScreen struct {
	c                      *winCapture
	p                      CaptureParams
	device, ctx, dupl      com
	frameTex, outTex, stg  com
	vdev, vctx, venum      com
	vproc, inView, outView com
	enc                    *mftEncoder
	srcW, srcH, w, h       int
	viaProcessor           bool
	scaler                 *bgraScaler
	cpuPix                 []byte

	// the pointer is not in the duplicated picture: it is read from the system and blended in before the picture is encoded
	pointer          pointer
	originX, originY int
	moved            bool
	overlay          []byte

	stream  vpStream
	mapped  d3dMappedSubresource
	info    dxgiOutDuplFrameInfo
	res     uintptr
	tex     uintptr
	inDesc  vpInputViewDesc
	outDesc vpOutputViewDesc
	content vpContentDesc
}

func (s *dxgiScreen) release() {
	if s.enc != nil {
		s.c.enc.Store(nil)
		s.enc.Close()
	}
	for _, c := range []com{s.outView, s.inView, s.vproc, s.venum, s.vctx, s.vdev, s.stg, s.outTex, s.frameTex, s.dupl, s.ctx, s.device} {
		c.release()
	}
}

func (s *dxgiScreen) texture(w, h int, usage, bind, cpu uint32) (com, error) {
	d := d3dTexture2DDesc{width: uint32(w), height: uint32(h), mipLevels: 1, arraySize: 1, format: dxgiFormatBGRA8,
		sampleCount: 1, usage: usage, bindFlags: bind, cpuAccess: cpu}
	var tex uintptr
	if hr := s.device.call(5, uintptr(unsafe.Pointer(&d)), 0, uintptr(unsafe.Pointer(&tex))); hr.failed() { // CreateTexture2D
		return 0, hr.err("CreateTexture2D")
	}
	return com(tex), nil
}

func duplicateError(hr hresult) error {
	switch hr {
	case hrAccessDenied:
		return fmt.Errorf("the screen cannot be captured now (a secure screen such as the Windows security prompt is showing): %w", hr)
	case dxgiNotAvailable:
		return fmt.Errorf("too many programs are capturing the screen: close one and try again: %w", hr)
	case dxgiUnsupported:
		return fmt.Errorf("this display cannot be captured (a remote or mirrored display): %w", hr)
	}
	return hr.err("DuplicateOutput")
}

// build opens the duplication of the display and everything that depends on its size.
func (s *dxgiScreen) build() error {
	adapter, output, err := pickOutput(s.p.Display)
	if err != nil {
		return err
	}
	defer adapter.release()
	defer output.release()
	if s.device, err = winD3DDevice(adapter); err != nil {
		return err
	}
	s.device.raw(40, uintptr(unsafe.Pointer(&s.ctx))) // GetImmediateContext returns void
	if s.ctx == 0 {
		return errors.New("GetImmediateContext gave no context")
	}
	var desc0 dxgiOutputDesc
	output.call(7, uintptr(unsafe.Pointer(&desc0))) // GetDesc
	s.originX, s.originY = int(desc0.left), int(desc0.top)
	out1, err := output.queryInterface(&iidIDXGIOutput1)
	if err != nil {
		return err
	}
	defer out1.release()
	if hr := out1.call(22, uintptr(s.device), uintptr(unsafe.Pointer(&s.dupl))); hr.failed() { // DuplicateOutput
		return duplicateError(hr)
	}
	var desc dxgiOutDuplDesc
	s.dupl.call(7, uintptr(unsafe.Pointer(&desc))) // GetDesc
	s.srcW, s.srcH = int(desc.width), int(desc.height)
	if s.srcW < 2 || s.srcH < 2 {
		return fmt.Errorf("display reports a size of %dx%d", s.srcW, s.srcH)
	}
	s.w, s.h = scaledSize(s.srcW, s.srcH, s.p.Height)
	if s.frameTex, err = s.texture(s.srcW, s.srcH, 0, d3dBindShaderRes|d3dBindRenderTarget, 0); err != nil {
		return err
	}
	stagingW, stagingH := s.srcW, s.srcH
	if s.w != s.srcW || s.h != s.srcH {
		if s.buildProcessor() == nil {
			s.viaProcessor = true
			stagingW, stagingH = s.w, s.h
		} else {
			s.dropProcessor()
			s.scaler = newBGRAScaler(s.srcW, s.srcH, s.w, s.h)
			s.cpuPix = make([]byte, s.w*s.h*4)
		}
	}
	if s.stg, err = s.texture(stagingW, stagingH, d3dUsageStaging, 0, d3dCPUAccessRead); err != nil {
		return err
	}
	s.enc, err = newMFTEncoder(EncodeParams{Width: s.w, Height: s.h, FPS: s.p.FPS, BitrateKbps: s.p.BitrateKbps,
		Matrix: s.p.Matrix, Backend: s.p.Backend}, s.onAU, nil)
	if err == nil {
		s.c.enc.Store(s.enc)
	}
	return err
}

// buildProcessor makes the video processor that scales frameTex into outTex on the graphics hardware. Any failure leaves
// the capture to scale on the CPU instead.
func (s *dxgiScreen) buildProcessor() error {
	var err error
	if s.outTex, err = s.texture(s.w, s.h, 0, d3dBindRenderTarget, 0); err != nil {
		return err
	}
	if s.vdev, err = s.device.queryInterface(&iidID3D11VideoDevice); err != nil {
		return err
	}
	if s.vctx, err = s.ctx.queryInterface(&iidID3D11VideoContext); err != nil {
		return err
	}
	s.content = vpContentDesc{inRateNum: uint32(s.p.FPS), inRateDen: 1, inWidth: uint32(s.srcW), inHeight: uint32(s.srcH),
		outRateNum: uint32(s.p.FPS), outRateDen: 1, outWidth: uint32(s.w), outHeight: uint32(s.h)}
	if hr := s.vdev.call(10, uintptr(unsafe.Pointer(&s.content)), uintptr(unsafe.Pointer(&s.venum))); hr.failed() {
		return hr.err("CreateVideoProcessorEnumerator")
	}
	if hr := s.vdev.call(4, uintptr(s.venum), 0, uintptr(unsafe.Pointer(&s.vproc))); hr.failed() {
		return hr.err("CreateVideoProcessor")
	}
	s.inDesc = vpInputViewDesc{viewDimension: vpDimensionTexture2}
	if hr := s.vdev.call(8, uintptr(s.frameTex), uintptr(s.venum), uintptr(unsafe.Pointer(&s.inDesc)), uintptr(unsafe.Pointer(&s.inView))); hr.failed() {
		return hr.err("CreateVideoProcessorInputView")
	}
	s.outDesc = vpOutputViewDesc{viewDimension: vpDimensionTexture2}
	if hr := s.vdev.call(9, uintptr(s.outTex), uintptr(s.venum), uintptr(unsafe.Pointer(&s.outDesc)), uintptr(unsafe.Pointer(&s.outView))); hr.failed() {
		return hr.err("CreateVideoProcessorOutputView")
	}
	s.stream = vpStream{enable: 1, inputSurface: uintptr(s.inView)}
	s.vctx.call(37, uintptr(s.vproc), 0, 0) // VideoProcessorSetStreamAutoProcessingMode off: no filters of the driver's own
	if hr := s.vctx.call(53, uintptr(s.vproc), uintptr(s.outView), 0, 1, uintptr(unsafe.Pointer(&s.stream))); hr.failed() {
		return hr.err("VideoProcessorBlt")
	}
	return nil
}

// dropProcessor frees what buildProcessor made, for a graphics driver that cannot do the scaling.
func (s *dxgiScreen) dropProcessor() {
	for _, c := range []*com{&s.outView, &s.inView, &s.vproc, &s.venum, &s.vctx, &s.vdev, &s.outTex} {
		c.release()
		*c = 0
	}
}

func (s *dxgiScreen) onAU(au []byte) { s.c.deliver(au) }

// acquire waits up to timeout for the desktop to change; got is true when there is a new picture in frameTex.
func (s *dxgiScreen) acquire(timeout time.Duration) (got bool, err error) {
	hr := s.dupl.call(8, uintptr(timeout.Milliseconds()), uintptr(unsafe.Pointer(&s.info)), uintptr(unsafe.Pointer(&s.res))) // AcquireNextFrame
	switch {
	case hr == dxgiWaitTimeout:
		return false, nil
	case hr == dxgiAccessLost:
		return false, errRebuildScreen
	case hr.failed():
		return false, hr.err("AcquireNextFrame")
	}
	res := com(s.res)
	defer s.dupl.call(14) // ReleaseFrame
	defer res.release()
	if s.info.lastPresentTime == 0 {
		s.moved = s.info.lastMouseUpdateTime != 0
		return false, nil // only the pointer moved
	}
	if hr := res.call(0, iidID3D11Texture2D.p(), uintptr(unsafe.Pointer(&s.tex))); hr.failed() {
		return false, hr.err("QueryInterface(ID3D11Texture2D)")
	}
	s.ctx.call(47, uintptr(s.frameTex), s.tex) // CopyResource
	com(s.tex).release()
	return true, nil
}

// encode sends the picture in frameTex to the encoder.
func (s *dxgiScreen) encode() error {
	if s.viaProcessor {
		if hr := s.vctx.call(53, uintptr(s.vproc), uintptr(s.outView), 0, 1, uintptr(unsafe.Pointer(&s.stream))); hr.failed() { // VideoProcessorBlt
			return hr.err("VideoProcessorBlt")
		}
		s.ctx.call(47, uintptr(s.stg), uintptr(s.outTex))
	} else {
		s.ctx.call(47, uintptr(s.stg), uintptr(s.frameTex))
	}
	if hr := s.ctx.call(14, uintptr(s.stg), 0, d3dMapRead, 0, uintptr(unsafe.Pointer(&s.mapped))); hr.failed() { // Map
		if hr == dxgiDeviceRemoved {
			return errRebuildScreen
		}
		return hr.err("Map")
	}
	defer s.ctx.call(15, uintptr(s.stg), 0) // Unmap
	rows := s.h
	if !s.viaProcessor {
		rows = s.srcH
	}
	pix := unsafe.Slice((*byte)(at(s.mapped.data)), int(s.mapped.rowPitch)*rows)
	scale := float64(s.w) / float64(s.srcW)
	if s.scaler != nil {
		s.scaler.scale(s.cpuPix, pix, int(s.mapped.rowPitch))
		if shape, x, y, ok := s.pointer.visible(s.originX, s.originY, s.w, s.h, scale); ok {
			shape.blend(s.cpuPix, s.w*4, s.w, s.h, x, y, scale)
		}
		return s.enc.EncodeBGRA(s.cpuPix, s.w*4)
	}
	w, h := s.srcW, s.srcH
	if s.viaProcessor {
		w, h = s.w, s.h
	} else {
		scale = 1
	}
	if shape, x, y, ok := s.pointer.visible(s.originX, s.originY, w, h, scale); ok {
		// The mapped memory is the graphics card's to be read, so the picture is copied to be drawn on.
		s.overlay = append(s.overlay[:0], pix...)
		shape.blend(s.overlay, int(s.mapped.rowPitch), w, h, x, y, scale)
		return s.enc.EncodeBGRA(s.overlay, int(s.mapped.rowPitch))
	}
	return s.enc.EncodeBGRA(pix, int(s.mapped.rowPitch))
}

// loop captures until Close or an error. A picture is sent when the desktop changed and the frame interval has passed;
// a still desktop sends its last picture once a second so that a viewer who joins late has something to show.
func (s *dxgiScreen) loop() error {
	interval := time.Second / time.Duration(s.p.FPS)
	var next, lastSent time.Time
	have, dirty := false, false
	for !s.c.closed.Load() {
		now := time.Now()
		wait := screenIdleResend - now.Sub(lastSent)
		if dirty {
			wait = next.Sub(now)
		}
		got, err := s.acquire(min(max(wait, 0), screenMaxWait))
		if err != nil {
			return err
		}
		have = have || got
		dirty = dirty || got || (have && s.moved)
		s.moved = false
		now = time.Now()
		due := dirty && !now.Before(next)
		idle := !dirty && now.Sub(lastSent) >= screenIdleResend
		wanted := s.enc.keyReq.Load() && !now.Before(next)
		if have && (due || idle || wanted) {
			if err := s.encode(); err != nil {
				return err
			}
			dirty, lastSent, next = false, now, now.Add(interval)
		}
	}
	return nil
}

func (c *winCapture) runScreen(p CaptureParams, onAU func([]byte), ready chan<- error) {
	defer close(c.done)
	end, err := comSession()
	if err != nil {
		ready <- err
		return
	}
	defer end()
	c.deliver = onAU
	first, failures := true, 0
	for !c.closed.Load() {
		s := &dxgiScreen{c: c, p: p}
		began := time.Now()
		err := s.build()
		if err == nil {
			if first {
				c.mode = "dxgi desktop duplication, " + s.enc.Mode()
				ready <- nil
				first = false
			}
			err = s.loop()
		}
		s.release()
		if err == nil || c.closed.Load() {
			break
		}
		if first {
			ready <- err
			return
		}
		if time.Since(began) > screenStableAfter {
			failures = 0
		}
		if failures++; failures > screenRetryGiveUp {
			c.finish(err)
			return
		}
		time.Sleep(screenRetryEvery)
	}
	if first {
		ready <- errEncoderClosed
	}
}
