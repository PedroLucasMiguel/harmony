package video

import "harmony/v2/internal/video/native"

// A Frame can also hold its picture in graphics memory: the decoder hands over the picture where it was made, the window's
// graphics context binds it as a texture and copies it, on the graphics hardware, into one that it keeps. The picture is
// never in system memory, never converted or copied by the processor. A window that cannot do that, or a picture it cannot
// bind, gets the picture in system memory as before: the Frame falls back for good and View and Copy have it.
type gpuState struct {
	// under Frame.mu
	enabled bool
	broken  bool
	dead    bool
	pending native.GPUPicture

	// the thread that owns the window's graphics context
	imp  *glImporter
	id   uint32
	w, h int
}

// EnableGPU lets the Frame keep pictures in graphics memory; call it for a Frame that a window draws, before the decoder is
// started. It does nothing on a system that cannot bind the pictures as textures.
func (f *Frame) EnableGPU() {
	if !glSupported() {
		return
	}
	f.mu.Lock()
	f.gpu.enabled = true
	f.mu.Unlock()
}

// wantsGPU says whether the decoder is to give pictures as GPU pictures.
func (f *Frame) wantsGPU() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.gpu.enabled && !f.gpu.broken && !f.gpu.dead
}

// publishGPU takes a picture from the decoder. It is the newest one: a picture the window had not taken yet is let go.
func (f *Frame) publishGPU(p native.GPUPicture) {
	w, h := p.Size()
	f.mu.Lock()
	if !f.gpu.enabled || f.gpu.broken || f.gpu.dead {
		f.mu.Unlock()
		f.publishRead(p)
		return
	}
	old := f.gpu.pending
	f.gpu.pending = p
	f.w, f.h = w, h
	f.version++
	f.mu.Unlock()
	if old != nil {
		old.Release()
	}
	if f.onPicture != nil {
		f.onPicture()
	}
}

// publishRead shows a GPU picture from system memory.
func (f *Frame) publishRead(p native.GPUPicture) {
	w, h := p.Size()
	if p.Read(f.target(w, h)) {
		f.publish()
	}
	p.Release()
}

// Texture is the latest picture as an OpenGL texture, for the thread that has the window's graphics context. ok is false
// when the Frame shows its pictures from system memory (use View). The texture belongs to the Frame and is the same one until
// the picture's size changes; version counts the pictures as Version does.
func (f *Frame) Texture(have uint64) (id uint32, w, h int, version uint64, ok bool) {
	f.mu.Lock()
	if !f.gpu.enabled || f.gpu.broken {
		f.mu.Unlock()
		f.freeGL()
		return 0, 0, 0, 0, false
	}
	if f.gpu.dead {
		p := f.gpu.pending
		f.gpu.pending = nil
		f.mu.Unlock()
		if p != nil {
			p.Release()
		}
		f.freeGL()
		return 0, 0, 0, 0, false
	}
	p := f.gpu.pending
	f.gpu.pending = nil
	version = f.version
	f.mu.Unlock()
	if p != nil {
		if f.gpu.imp == nil {
			imp, err := newGLImporter()
			if err != nil {
				f.breakGPU(p)
				return 0, 0, 0, 0, false
			}
			f.gpu.imp = imp
		}
		pw, ph := p.Size()
		id, err := f.gpu.imp.upload(p, pw, ph)
		if err != nil {
			f.breakGPU(p)
			return 0, 0, 0, 0, false
		}
		p.Release()
		f.gpu.id, f.gpu.w, f.gpu.h = id, pw, ph
	}
	if f.gpu.id == 0 {
		return 0, 0, 0, version, false
	}
	return f.gpu.id, f.gpu.w, f.gpu.h, version, true
}

// breakGPU gives the Frame up on graphics memory: this picture and the ones after it are read into system memory.
func (f *Frame) breakGPU(p native.GPUPicture) {
	f.mu.Lock()
	f.gpu.broken = true
	f.mu.Unlock()
	f.freeGL()
	f.publishRead(p)
}

// FreeTexture is called when a window stops drawing the picture, from the thread that has the graphics context. The texture
// is kept while the stream is watched, because another tile may draw the same picture, and let go once it is not.
func (f *Frame) FreeTexture() {
	f.mu.Lock()
	dead := f.gpu.dead
	f.mu.Unlock()
	if dead {
		f.freeGL()
	}
}

func (f *Frame) freeGL() {
	if f.gpu.imp != nil {
		f.gpu.imp.free()
		f.gpu.imp = nil
	}
	f.gpu.id = 0
}
