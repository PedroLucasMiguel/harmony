//go:build darwin

package video

// Binding the IOSurface of a decoded picture as an OpenGL texture, on the window's graphics context. The surface becomes a
// rectangle texture (that is what CGL makes of one), and a copy on the graphics hardware puts it in an ordinary 2D texture
// that the painter draws like any other: no pixel passes through system memory.

import (
	"errors"
	"fmt"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"

	"harmony/v2/internal/video/native"
)

const openGLFramework = "/System/Library/Frameworks/OpenGL.framework/OpenGL"

const (
	glTexture2D            = 0x0DE1
	glTextureRectangle     = 0x84F5
	glRGBA                 = 0x1908
	glRGBA8                = 0x8058
	glBGRA                 = 0x80E1
	glUnsignedByte         = 0x1401
	glUnsignedInt8888Rev   = 0x8367
	glTextureMinFilter     = 0x2801
	glTextureMagFilter     = 0x2800
	glTextureWrapS         = 0x2802
	glTextureWrapT         = 0x2803
	glLinear               = 0x2601
	glClampToEdge          = 0x812F
	glReadFramebuffer      = 0x8CA8
	glReadFramebufferBind  = 0x8CAA
	glTextureBinding2D     = 0x8069
	glColorAttachment0     = 0x8CE0
	glFramebufferComplete  = 0x8CD5
	glFramebufferTargetAll = 0x8D40
)

type glAPI struct {
	genTextures, bindTexture, texParameteri, texImage2D, deleteTextures        uintptr
	genFramebuffers, bindFramebuffer, framebufferTexture2D, deleteFramebuffers uintptr
	checkFramebufferStatus, copyTexSubImage2D, flush, getIntegerv              uintptr
	currentContext, texImageIOSurface2D                                        uintptr
}

var (
	glOnce sync.Once
	gl     glAPI
	glErr  error
)

func glLoad() error {
	glOnce.Do(func() {
		lib, err := purego.Dlopen(openGLFramework, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			glErr = err
			return
		}
		fn := func(name string) uintptr {
			p, err := purego.Dlsym(lib, name)
			if err != nil && glErr == nil {
				glErr = err
			}
			return p
		}
		gl = glAPI{
			genTextures: fn("glGenTextures"), bindTexture: fn("glBindTexture"), texParameteri: fn("glTexParameteri"),
			texImage2D: fn("glTexImage2D"), deleteTextures: fn("glDeleteTextures"),
			genFramebuffers: fn("glGenFramebuffers"), bindFramebuffer: fn("glBindFramebuffer"),
			framebufferTexture2D: fn("glFramebufferTexture2D"), deleteFramebuffers: fn("glDeleteFramebuffers"),
			checkFramebufferStatus: fn("glCheckFramebufferStatus"), copyTexSubImage2D: fn("glCopyTexSubImage2D"),
			flush: fn("glFlush"), getIntegerv: fn("glGetIntegerv"),
			currentContext: fn("CGLGetCurrentContext"), texImageIOSurface2D: fn("CGLTexImageIOSurface2D"),
		}
	})
	return glErr
}

func glSupported() bool { return glLoad() == nil }

func glCall(fn uintptr, args ...uintptr) uintptr {
	r, _, _ := purego.SyscallN(fn, args...)
	return r
}

// glImporter makes the textures of one Frame. It belongs to the thread that has the graphics context.
type glImporter struct {
	rect, dst, fbo uint32
	w, h           int

	// memory the system writes through a pointer, on the heap so that the address stays put
	id    uint32
	saved [2]int32
}

func newGLImporter() (*glImporter, error) {
	if err := glLoad(); err != nil {
		return nil, err
	}
	if glCall(gl.currentContext) == 0 {
		return nil, errors.New("there is no graphics context on this thread")
	}
	g := &glImporter{}
	glCall(gl.genTextures, 1, ptr(&g.id))
	g.rect = g.id
	glCall(gl.genFramebuffers, 1, ptr(&g.id))
	g.fbo = g.id
	glCall(gl.bindTexture, glTextureRectangle, uintptr(g.rect))
	for _, p := range [][2]uintptr{{glTextureMinFilter, glLinear}, {glTextureMagFilter, glLinear}, {glTextureWrapS, glClampToEdge}, {glTextureWrapT, glClampToEdge}} {
		glCall(gl.texParameteri, glTextureRectangle, p[0], p[1])
	}
	glCall(gl.bindTexture, glTextureRectangle, 0)
	return g, nil
}

// size makes the 2D texture that pictures of w by h are copied into.
func (g *glImporter) size(w, h int) {
	if g.dst != 0 {
		g.id = g.dst
		glCall(gl.deleteTextures, 1, ptr(&g.id))
	}
	glCall(gl.genTextures, 1, ptr(&g.id))
	g.dst, g.w, g.h = g.id, w, h
	glCall(gl.getIntegerv, glTextureBinding2D, ptr(&g.saved[0]))
	glCall(gl.bindTexture, glTexture2D, uintptr(g.dst))
	for _, p := range [][2]uintptr{{glTextureMinFilter, glLinear}, {glTextureMagFilter, glLinear}, {glTextureWrapS, glClampToEdge}, {glTextureWrapT, glClampToEdge}} {
		glCall(gl.texParameteri, glTexture2D, p[0], p[1])
	}
	glCall(gl.texImage2D, glTexture2D, 0, glRGBA8, uintptr(w), uintptr(h), 0, glRGBA, glUnsignedByte, 0)
	glCall(gl.bindTexture, glTexture2D, uintptr(g.saved[0]))
}

// upload copies the picture into the 2D texture and returns it.
func (g *glImporter) upload(p native.GPUPicture, w, h int) (uint32, error) {
	surface := p.Handle()
	if surface == 0 || w <= 0 || h <= 0 {
		return 0, errors.New("the picture has no IOSurface")
	}
	ctx := glCall(gl.currentContext)
	if ctx == 0 {
		return 0, errors.New("there is no graphics context on this thread")
	}
	if g.dst == 0 || g.w != w || g.h != h {
		g.size(w, h)
	}
	glCall(gl.bindTexture, glTextureRectangle, uintptr(g.rect))
	if st := int32(glCall(gl.texImageIOSurface2D, ctx, glTextureRectangle, glRGBA8, uintptr(w), uintptr(h), glBGRA, glUnsignedInt8888Rev, surface, 0)); st != 0 {
		glCall(gl.bindTexture, glTextureRectangle, 0)
		return 0, fmt.Errorf("CGLTexImageIOSurface2D: error %d", st)
	}
	glCall(gl.getIntegerv, glReadFramebufferBind, ptr(&g.saved[1]))
	glCall(gl.bindFramebuffer, glReadFramebuffer, uintptr(g.fbo))
	glCall(gl.framebufferTexture2D, glReadFramebuffer, glColorAttachment0, glTextureRectangle, uintptr(g.rect), 0)
	var err error
	if status := glCall(gl.checkFramebufferStatus, glReadFramebuffer); status != glFramebufferComplete {
		err = fmt.Errorf("the picture cannot be read as a framebuffer: status %#x", status)
	} else {
		glCall(gl.getIntegerv, glTextureBinding2D, ptr(&g.saved[0]))
		glCall(gl.bindTexture, glTexture2D, uintptr(g.dst))
		glCall(gl.copyTexSubImage2D, glTexture2D, 0, 0, 0, 0, 0, uintptr(w), uintptr(h))
		glCall(gl.bindTexture, glTexture2D, uintptr(g.saved[0]))
	}
	glCall(gl.bindFramebuffer, glReadFramebuffer, uintptr(g.saved[1]))
	glCall(gl.bindTexture, glTextureRectangle, 0)
	// the surface may be reused by the decoder once the picture is let go: have the copy queued before that
	glCall(gl.flush)
	if err != nil {
		return 0, err
	}
	return g.dst, nil
}

func (g *glImporter) free() {
	for _, id := range []*uint32{&g.dst, &g.rect} {
		if *id != 0 {
			g.id = *id
			glCall(gl.deleteTextures, 1, ptr(&g.id))
			*id = 0
		}
	}
	if g.fbo != 0 {
		g.id = g.fbo
		glCall(gl.deleteFramebuffers, 1, ptr(&g.id))
		g.fbo = 0
	}
}

func ptr[T any](p *T) uintptr { return uintptr(unsafe.Pointer(p)) }
