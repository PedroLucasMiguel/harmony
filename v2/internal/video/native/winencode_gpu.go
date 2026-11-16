//go:build windows

// Pictures for the encoder that are in graphics memory. A hardware transform that reads Direct3D textures is given the
// device they are on; each of its inputs then wraps one NV12 texture, and the capture draws the next picture into the one
// that is free, so the picture goes from the screen to the encoder without the processor touching it.
package native

import "unsafe"

// gpuInput says where the pictures of an encoder are: the device, the vendor of its graphics adapter (a Backend ID), and
// one NV12 texture for each input of the encoder. The device and the textures belong to the caller.
type gpuInput struct {
	dev    com
	vendor string
	tex    [encPoolSize]com
}

var procMFCreateDXGISurfaceBuffer = dllMfplat.NewProc("MFCreateDXGISurfaceBuffer")

// mfCreateDXGISurfaceBuffer wraps a texture in a media buffer, for a transform that reads from graphics memory.
func mfCreateDXGISurfaceBuffer(tex com) (mfBuffer, error) {
	out := new(uintptr)
	if hr := callProc(procMFCreateDXGISurfaceBuffer, iidID3D11Texture2D.p(), uintptr(tex), 0, 0, uintptr(unsafe.Pointer(out))); hr.failed() {
		return mfBuffer{}, hr.err("MFCreateDXGISurfaceBuffer")
	}
	return mfBuffer{com(*out)}, nil
}

// attachDevice lets the transform read textures of the device. It does not for a software transform, for one that does not
// use Direct3D 11, or for one of another vendor than the adapter the textures are on: those take pictures in memory.
func (e *mftEncoder) attachDevice() error {
	g := e.gpuIn
	if e.act.com == 0 || g.vendor == "" || g.vendor != e.candBackend {
		return errNoTextures
	}
	attrs, ok := e.mft.attributes()
	if !ok {
		return errNoTextures
	}
	aware, found, _ := attrs.getUINT32(&mfSAD3D11Aware)
	attrs.release()
	if !found || aware == 0 {
		return errNoTextures
	}
	mgr, token, err := mfCreateDXGIDeviceManager()
	if err != nil {
		return err
	}
	if err := mgr.resetDevice(g.dev, token); err != nil {
		mgr.release()
		return err
	}
	if err := e.mft.processMessage(mftMsgSetD3DMgr, uintptr(mgr.com)).err("SET_D3D_MANAGER"); err != nil {
		mgr.release()
		return err
	}
	e.gpuMgr = mgr
	return nil
}
