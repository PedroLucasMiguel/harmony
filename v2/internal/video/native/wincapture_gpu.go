//go:build windows

// The screen capture without the processor in it. The desktop picture is scaled by the video processor (wincapture_screen.go),
// the pointer is drawn on the few pixels it covers, and a second pass of the video processor turns the picture into NV12 in
// a texture that the encoder reads. Nothing but the pixels under the pointer ever reaches system memory. When the
// graphics driver or the encoder cannot do this the capture goes the old way, through system memory.
package native

import (
	"errors"
	"sync/atomic"
	"unsafe"
)

const (
	dxgiFormatNV12Out = 103
	vpFormatNV12Out   = 2 // D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT
	// pointerBox is the most pixels, either way, of the patch the pointer is drawn on.
	pointerBox = 320
)

// gpuEncodeOff is set when the graphics path failed once: the capture then goes through system memory for good.
var gpuEncodeOff atomic.Bool

// d3dBox is D3D11_BOX.
type d3dBox struct{ left, top, front, right, bottom, back uint32 }

type screenGPU struct {
	s                    *dxgiScreen
	nv12                 [encPoolSize]com
	outViews             [encPoolSize]com
	vdev, vctx           com
	venum, vproc, inView com
	pstg, work           com
	patch                []byte

	// scratch, on the heap so that addresses handed to Windows stay put
	view    uintptr
	flags   uint32
	content vpContentDesc
	inDesc  vpInputViewDesc
	outDesc vpOutputViewDesc
	stream  vpStream
	mapped  d3dMappedSubresource
	box     d3dBox
	inCS    vpColorSpace
	outCS   vpColorSpace
	desc    d3dTexture2DDesc
	ptr     uintptr
}

// adapterVendor is the Backend ID of the vendor of a DXGI adapter, "" for one this client has no name for.
func adapterVendor(adapter com) string {
	var desc dxgiAdapterDesc1
	if hr := adapter.call(10, uintptr(unsafe.Pointer(&desc))); hr.failed() { // GetDesc1
		return ""
	}
	return vendorBackend(desc.vendorID)
}

func (g *screenGPU) texture(w, h int, format, usage, bind, cpu uint32) (com, error) {
	g.desc = d3dTexture2DDesc{width: uint32(w), height: uint32(h), mipLevels: 1, arraySize: 1, format: format, sampleCount: 1,
		usage: usage, bindFlags: bind, cpuAccess: cpu}
	if hr := g.s.device.call(5, uintptr(unsafe.Pointer(&g.desc)), 0, uintptr(unsafe.Pointer(&g.ptr))); hr.failed() { // CreateTexture2D
		return 0, hr.err("CreateTexture2D")
	}
	return com(g.ptr), nil
}

// buildGPU makes the second pass of the video processor and the NV12 textures it draws into. An error leaves nothing built.
func (s *dxgiScreen) buildGPU() error {
	if gpuEncodeOff.Load() {
		return errNoTextures
	}
	if !s.viaProcessor && (s.w != s.srcW || s.h != s.srcH) {
		return errNoTextures // the picture is scaled on the CPU
	}
	g := &screenGPU{s: s}
	s.gpu = g
	fail := func(err error) error {
		g.release()
		s.gpu = nil
		return err
	}
	src := s.outTex
	var err error
	if !s.viaProcessor {
		// the pointer is drawn on a copy of the picture, so that a picture sent again does not keep the old pointer on it
		if g.work, err = g.texture(s.w, s.h, dxgiFormatBGRA8, 0, d3dBindRenderTarget|d3dBindShaderRes, 0); err != nil {
			return fail(err)
		}
		src = g.work
	}
	if g.vdev, err = s.device.queryInterface(&iidID3D11VideoDevice); err != nil {
		return fail(err)
	}
	if g.vctx, err = s.ctx.queryInterface(&iidID3D11VideoContext); err != nil {
		return fail(err)
	}
	g.content = vpContentDesc{inRateNum: uint32(s.p.FPS), inRateDen: 1, inWidth: uint32(s.w), inHeight: uint32(s.h),
		outRateNum: uint32(s.p.FPS), outRateDen: 1, outWidth: uint32(s.w), outHeight: uint32(s.h)}
	if hr := g.vdev.call(10, uintptr(unsafe.Pointer(&g.content)), uintptr(unsafe.Pointer(&g.venum))); hr.failed() {
		return fail(hr.err("CreateVideoProcessorEnumerator"))
	}
	if hr := g.venum.call(8, dxgiFormatNV12Out, uintptr(unsafe.Pointer(&g.flags))); hr.failed() || g.flags&vpFormatNV12Out == 0 {
		return fail(errNoTextures)
	}
	if hr := g.vdev.call(4, uintptr(g.venum), 0, uintptr(unsafe.Pointer(&g.view))); hr.failed() {
		return fail(hr.err("CreateVideoProcessor"))
	}
	g.vproc = com(g.view)
	g.inDesc = vpInputViewDesc{viewDimension: vpDimensionTexture2}
	if hr := g.vdev.call(8, uintptr(src), uintptr(g.venum), uintptr(unsafe.Pointer(&g.inDesc)), uintptr(unsafe.Pointer(&g.view))); hr.failed() {
		return fail(hr.err("CreateVideoProcessorInputView"))
	}
	g.inView = com(g.view)
	for i := range g.nv12 {
		if g.nv12[i], err = g.texture(s.w, s.h, dxgiFormatNV12Out, 0, d3dBindRenderTarget|d3dBindShaderRes, 0); err != nil {
			return fail(err)
		}
		g.outDesc = vpOutputViewDesc{viewDimension: vpDimensionTexture2}
		if hr := g.vdev.call(9, uintptr(g.nv12[i]), uintptr(g.venum), uintptr(unsafe.Pointer(&g.outDesc)), uintptr(unsafe.Pointer(&g.view))); hr.failed() {
			return fail(hr.err("CreateVideoProcessorOutputView"))
		}
		g.outViews[i] = com(g.view)
	}
	g.vctx.call(37, uintptr(g.vproc), 0, 0) // no filters of the driver's own
	g.inCS = 0                              // RGB in the full range
	g.vctx.call(28, uintptr(g.vproc), 0, uintptr(unsafe.Pointer(&g.inCS)))
	g.outCS = outputYCbCr(s.p.Matrix)
	g.vctx.call(15, uintptr(g.vproc), uintptr(unsafe.Pointer(&g.outCS)))
	g.stream = vpStream{enable: 1, inputSurface: uintptr(g.inView)}
	return nil
}

// outputYCbCr is the colour space the NV12 picture is made in: the matrix of the stream, the limited range.
func outputYCbCr(matrix int) vpColorSpace {
	cs := vpColorSpace(vpRangeLimited << 4)
	if matrix == BT709 {
		cs |= 1 << 2
	}
	return cs
}

func (g *screenGPU) release() {
	for i := range g.nv12 {
		g.outViews[i].release()
		g.nv12[i].release()
	}
	for _, c := range []com{g.pstg, g.work, g.inView, g.vproc, g.venum, g.vctx, g.vdev} {
		c.release()
	}
	*g = screenGPU{}
}

// render is what the encoder calls with the texture it has room for: the second pass of the video processor draws the
// picture into it.
func (g *screenGPU) render(tex uintptr) error {
	for i, t := range g.nv12 {
		if uintptr(t) == tex {
			if hr := g.vctx.call(53, uintptr(g.vproc), uintptr(g.outViews[i]), 0, 1, uintptr(unsafe.Pointer(&g.stream))); hr.failed() { // VideoProcessorBlt
				return hr.err("VideoProcessorBlt")
			}
			return nil
		}
	}
	return errors.New("the encoder named a texture that is not one of its own")
}

// encodeGPU sends the picture that is in frameTex to the encoder without reading it back.
func (s *dxgiScreen) encodeGPU() error {
	g := s.gpu
	src, w, h, scale := g.work, s.srcW, s.srcH, 1.0
	if !s.viaProcessor {
		s.ctx.call(47, uintptr(g.work), uintptr(s.frameTex)) // CopyResource
	} else {
		if hr := s.vctx.call(53, uintptr(s.vproc), uintptr(s.outView), 0, 1, uintptr(unsafe.Pointer(&s.stream))); hr.failed() { // VideoProcessorBlt
			return hr.err("VideoProcessorBlt")
		}
		src, w, h, scale = s.outTex, s.w, s.h, float64(s.w)/float64(s.srcW)
	}
	if shape, x, y, ok := s.pointer.visible(s.originX, s.originY, w, h, scale); ok {
		g.drawPointer(src, shape, x, y, w, h, scale)
	}
	if err := s.enc.EncodeTexture(g.render); err != nil {
		if !errors.Is(err, dxgiDeviceRemoved) {
			gpuEncodeOff.Store(true)
		}
		return errRebuildScreen
	}
	return nil
}

// drawPointer draws the pointer on the picture in tex. Only the box the pointer covers is read back, drawn on and put back.
func (g *screenGPU) drawPointer(tex com, shape *cursorShape, x, y, w, h int, scale float64) {
	rw, rh := int(float64(shape.w)*scale)+2, int(float64(shape.h)*scale)+2
	bx, by := max(0, x-1), max(0, y-1)
	bw, bh := min(w, x+rw)-bx, min(h, y+rh)-by
	if bw <= 0 || bh <= 0 || bw > pointerBox || bh > pointerBox {
		return
	}
	s := g.s
	if g.pstg == 0 {
		var err error
		if g.pstg, err = g.texture(pointerBox, pointerBox, dxgiFormatBGRA8, d3dUsageStaging, 0, d3dCPUAccessRead); err != nil {
			return
		}
	}
	g.box = d3dBox{left: uint32(bx), top: uint32(by), right: uint32(bx + bw), bottom: uint32(by + bh), back: 1}
	s.ctx.call(46, uintptr(g.pstg), 0, 0, 0, 0, uintptr(tex), 0, uintptr(unsafe.Pointer(&g.box)))                 // CopySubresourceRegion
	if hr := s.ctx.call(14, uintptr(g.pstg), 0, d3dMapRead, 0, uintptr(unsafe.Pointer(&g.mapped))); hr.failed() { // Map
		return
	}
	pitch := int(g.mapped.rowPitch)
	if cap(g.patch) < bw*bh*4 {
		g.patch = make([]byte, bw*bh*4)
	}
	g.patch = g.patch[:bw*bh*4]
	mem := unsafe.Slice((*byte)(at(g.mapped.data)), pitch*bh)
	for row := 0; row < bh; row++ {
		copy(g.patch[row*bw*4:(row+1)*bw*4], mem[row*pitch:row*pitch+bw*4])
	}
	s.ctx.call(15, uintptr(g.pstg), 0) // Unmap
	shape.blend(g.patch, bw*4, bw, bh, x-bx, y-by, scale)
	s.ctx.call(48, uintptr(tex), 0, uintptr(unsafe.Pointer(&g.box)), uintptr(unsafe.Pointer(&g.patch[0])), uintptr(bw*4), 0) // UpdateSubresource
}
