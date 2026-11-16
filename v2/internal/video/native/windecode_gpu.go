//go:build windows

// A decoded picture stays in graphics memory until it is small. The decoder's NV12 texture goes through the video
// processor, which crops it, scales it to the size it is drawn at and turns it into RGB there; only that small picture is
// read back for the window. The CPU never sees the full-size picture, and never scales or converts one. Anything the
// graphics driver cannot do hands the picture back to the CPU path in windecode_run.go, which still works.
package native

import (
	"unsafe"
)

const (
	dxgiFormatNV12  = 103
	dxgiFormatRGBA8 = 28

	// vpFormatOutput is D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT.
	vpFormatOutput = 2

	// gpuMaxViews is how many input views are kept (one per texture of the decoder's pool) before they are all let go.
	gpuMaxViews = 64
	// gpuGiveUpAfter is how many pictures in a row the video processor may fail before the decoder stops trying it.
	gpuGiveUpAfter = 3
)

type gpuKey struct {
	tex   uintptr
	index uint32
}

type gpuRect struct{ left, top, right, bottom int32 }

// winGPU is the video processor of one decoder, on the Direct3D device the pictures are on, for one size of picture.
type winGPU struct {
	dev, ctx, vdev, vctx com
	venum, vproc         com
	outTex, outView, stg com
	views                map[gpuKey]com
	srcW, srcH           uint32
	crop                 gpuRect
	outW, outH           int
	rgba                 bool
	inColour, outColour  vpColorSpace
	built                bool

	// call scratch, on the heap so that addresses handed to Windows stay put
	buf, dxgi, tex, devPtr, view uintptr
	index                        uint32
	flags                        uint32
	desc                         d3dTexture2DDesc
	content                      vpContentDesc
	inDesc                       vpInputViewDesc
	outDesc                      vpOutputViewDesc
	stream                       vpStream
	mapped                       d3dMappedSubresource
	full                         gpuRect
}

func (g *winGPU) free(c *com) {
	if *c != 0 {
		c.release()
		*c = 0
	}
}

// drop lets go of everything built for one device and size.
func (g *winGPU) drop() {
	for k, v := range g.views {
		v.release()
		delete(g.views, k)
	}
	for _, c := range []*com{&g.outView, &g.stg, &g.outTex, &g.vproc, &g.venum, &g.vctx, &g.vdev, &g.ctx, &g.dev} {
		g.free(c)
	}
	g.built = false
}

// build makes the video processor for pictures of srcW by srcH (the decoder's texture) of which crop is shown, drawn at
// outW by outH, on dev.
func (g *winGPU) build(dev com, srcW, srcH uint32, crop gpuRect, outW, outH int) error {
	g.drop()
	dev.addRef()
	g.dev = dev
	if hr := dev.call(40, uintptr(unsafe.Pointer(&g.devPtr))); hr.failed() { // GetImmediateContext
		return hr.err("GetImmediateContext")
	}
	g.ctx = com(g.devPtr)
	var err error
	if g.vdev, err = dev.queryInterface(&iidID3D11VideoDevice); err != nil {
		return err
	}
	if g.vctx, err = g.ctx.queryInterface(&iidID3D11VideoContext); err != nil {
		return err
	}
	g.content = vpContentDesc{inRateNum: 30, inRateDen: 1, inWidth: srcW, inHeight: srcH, outRateNum: 30, outRateDen: 1,
		outWidth: uint32(outW), outHeight: uint32(outH)}
	if hr := g.vdev.call(10, uintptr(unsafe.Pointer(&g.content)), uintptr(unsafe.Pointer(&g.venum))); hr.failed() {
		return hr.err("CreateVideoProcessorEnumerator")
	}
	if hr := g.vdev.call(4, uintptr(g.venum), 0, uintptr(unsafe.Pointer(&g.devPtr))); hr.failed() {
		return hr.err("CreateVideoProcessor")
	}
	g.vproc = com(g.devPtr)
	g.rgba = false
	if hr := g.venum.call(8, dxgiFormatRGBA8, uintptr(unsafe.Pointer(&g.flags))); hr >= 0 && g.flags&vpFormatOutput != 0 {
		g.rgba = true
	}
	format := uint32(dxgiFormatBGRA8)
	if g.rgba {
		format = dxgiFormatRGBA8
	}
	if g.outTex, err = g.texture(outW, outH, format, 0, d3dBindRenderTarget, 0); err != nil {
		return err
	}
	if g.stg, err = g.texture(outW, outH, format, d3dUsageStaging, 0, d3dCPUAccessRead); err != nil {
		return err
	}
	g.outDesc = vpOutputViewDesc{viewDimension: vpDimensionTexture2}
	if hr := g.vdev.call(9, uintptr(g.outTex), uintptr(g.venum), uintptr(unsafe.Pointer(&g.outDesc)), uintptr(unsafe.Pointer(&g.view))); hr.failed() {
		return hr.err("CreateVideoProcessorOutputView")
	}
	g.outView = com(g.view)
	g.full = gpuRect{0, 0, int32(outW), int32(outH)}
	g.vctx.call(37, uintptr(g.vproc), 0, 0) // no filters of the driver's own
	g.vctx.call(13, uintptr(g.vproc), 1, uintptr(unsafe.Pointer(&g.full)))
	g.vctx.call(31, uintptr(g.vproc), 0, 1, uintptr(unsafe.Pointer(&g.full)))
	g.outColour = outputColorSpace
	g.vctx.call(15, uintptr(g.vproc), uintptr(unsafe.Pointer(&g.outColour))) // SetOutputColorSpace
	g.crop = crop
	g.vctx.call(30, uintptr(g.vproc), 0, 1, uintptr(unsafe.Pointer(&g.crop)))
	g.srcW, g.srcH, g.outW, g.outH = srcW, srcH, outW, outH
	g.views = make(map[gpuKey]com)
	g.inColour = ^vpColorSpace(0)
	g.built = true
	return nil
}

func (g *winGPU) texture(w, h int, format, usage, bind, cpu uint32) (com, error) {
	g.desc = d3dTexture2DDesc{width: uint32(w), height: uint32(h), mipLevels: 1, arraySize: 1, format: format, sampleCount: 1,
		usage: usage, bindFlags: bind, cpuAccess: cpu}
	if hr := g.dev.call(5, uintptr(unsafe.Pointer(&g.desc)), 0, uintptr(unsafe.Pointer(&g.devPtr))); hr.failed() { // CreateTexture2D
		return 0, hr.err("CreateTexture2D")
	}
	return com(g.devPtr), nil
}

// inputView is the processor's view of one slice of the decoder's texture.
func (g *winGPU) inputView(tex uintptr, index uint32) (com, error) {
	key := gpuKey{tex, index}
	if v, ok := g.views[key]; ok {
		return v, nil
	}
	if len(g.views) >= gpuMaxViews {
		for k, v := range g.views {
			v.release()
			delete(g.views, k)
		}
	}
	g.inDesc = vpInputViewDesc{viewDimension: vpDimensionTexture2, arraySlice: index}
	if hr := g.vdev.call(8, tex, uintptr(g.venum), uintptr(unsafe.Pointer(&g.inDesc)), uintptr(unsafe.Pointer(&g.view))); hr.failed() {
		return 0, hr.err("CreateVideoProcessorInputView")
	}
	v := com(g.view)
	g.views[key] = v
	return v, nil
}

// pictureGPU shows the picture in sample s through the video processor and reports whether it did; false leaves the
// picture to the CPU path.
func (d *winDecoder) pictureGPU(m *winMFT, s mfSample, matrix int, full bool) bool {
	if d.gpuOff || m.noTexture {
		return false
	}
	g := d.gpu
	if g == nil {
		g = &winGPU{}
		d.gpu = g
	}
	ok := d.gpuPicture(g, m, s, matrix, full)
	if ok {
		d.gpuFails = 0
		d.gpuUsed.Store(true)
		return true
	}
	if d.gpuFails++; d.gpuFails >= gpuGiveUpAfter {
		d.gpuOff = true
		g.drop()
		d.gpuUsed.Store(false)
	}
	return false
}

func (d *winDecoder) gpuPicture(g *winGPU, m *winMFT, s mfSample, matrix int, full bool) bool {
	if hr := s.call(40, 0, uintptr(unsafe.Pointer(&g.buf))); hr.failed() { // GetBufferByIndex
		return false
	}
	buf := com(g.buf)
	defer buf.release()
	if hr := buf.call(0, iidIMFDXGIBuffer.p(), uintptr(unsafe.Pointer(&g.dxgi))); hr.failed() {
		m.noTexture = true // a picture in system memory: this decoder never makes textures
		return false
	}
	dxgi := com(g.dxgi)
	defer dxgi.release()
	if hr := dxgi.call(3, iidID3D11Texture2D.p(), uintptr(unsafe.Pointer(&g.tex))); hr.failed() { // GetResource
		return false
	}
	tex := com(g.tex)
	defer tex.release()
	if hr := dxgi.call(4, uintptr(unsafe.Pointer(&g.index))); hr.failed() { // GetSubresourceIndex
		return false
	}
	index := g.index
	tex.call(10, uintptr(unsafe.Pointer(&g.desc))) // GetDesc
	if g.desc.format != dxgiFormatNV12 {
		m.noTexture = true
		return false
	}
	srcW, srcH := g.desc.width, g.desc.height
	if hr := tex.call(3, uintptr(unsafe.Pointer(&g.devPtr))); hr.failed() { // GetDevice
		return false
	}
	dev := com(g.devPtr)
	defer dev.release()
	vw, vh, cx, cy := m.vw&^1, m.vh&^1, m.cx&^1, m.cy&^1
	ow, oh := winFit(vw, vh, d.p.Width, d.p.Height)
	crop := gpuRect{int32(cx), int32(cy), int32(cx + vw), int32(cy + vh)}
	if vw < 2 || vh < 2 || cx+vw > int(srcW) || cy+vh > int(srcH) {
		return false
	}
	if !g.built || g.dev != dev || g.srcW != srcW || g.srcH != srcH || g.crop != crop || g.outW != ow || g.outH != oh {
		if err := g.build(dev, srcW, srcH, crop, ow, oh); err != nil {
			d.lastError = err
			g.drop()
			return false
		}
	}
	if cs := inputColorSpace(matrix, full); cs != g.inColour {
		g.inColour = cs
		g.vctx.call(28, uintptr(g.vproc), 0, uintptr(unsafe.Pointer(&g.inColour))) // SetStreamColorSpace
	}
	view, err := g.inputView(uintptr(tex), index)
	if err != nil {
		d.lastError = err
		return false
	}
	g.stream = vpStream{enable: 1, inputSurface: uintptr(view)}
	if hr := g.vctx.call(53, uintptr(g.vproc), uintptr(g.outView), 0, 1, uintptr(unsafe.Pointer(&g.stream))); hr.failed() { // VideoProcessorBlt
		d.lastError = hr.err("VideoProcessorBlt")
		return false
	}
	g.ctx.call(47, uintptr(g.stg), uintptr(g.outTex))                                                            // CopyResource
	if hr := g.ctx.call(14, uintptr(g.stg), 0, d3dMapRead, 0, uintptr(unsafe.Pointer(&g.mapped))); hr.failed() { // Map
		d.lastError = hr.err("Map")
		return false
	}
	defer g.ctx.call(15, uintptr(g.stg), 0) // Unmap
	pitch := int(g.mapped.rowPitch)
	if pitch < ow*4 {
		return false
	}
	d.rgba = grow(d.rgba, ow*oh*4)
	src := bytesAt(g.mapped.data, pitch*(oh-1)+ow*4)
	if g.rgba {
		for y := 0; y < oh; y++ {
			copy(d.rgba[y*ow*4:(y+1)*ow*4], src[y*pitch:y*pitch+ow*4])
		}
	} else {
		for y := 0; y < oh; y++ {
			swapRB(d.rgba[y*ow*4:(y+1)*ow*4], src[y*pitch:y*pitch+ow*4])
		}
	}
	m.shown++
	m.errs = 0
	d.onPicture(d.rgba, ow, oh)
	return true
}
