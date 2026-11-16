//go:build darwin

package native

import "unsafe"

// macPicture is a decoded picture that stays in graphics memory: the pixel buffer VideoToolbox made, which is backed by an
// IOSurface that the window binds as a texture.
type macPicture struct {
	api  *mdecAPI
	buf  uintptr
	w, h int
}

func (p *macPicture) Size() (int, int) { return p.w, p.h }

// Handle is the IOSurface of the picture; the picture keeps it alive. 0 when the buffer has none.
func (p *macPicture) Handle() uintptr {
	if p.buf == 0 || p.api.cvIOSurface == 0 {
		return 0
	}
	return mdecCall(p.api.cvIOSurface, p.buf)
}

// Read copies the picture to dst as RGBA: it maps the buffer into system memory, which the drawing path above avoids.
func (p *macPicture) Read(dst []byte) bool {
	a := p.api
	if p.buf == 0 || len(dst) < p.w*p.h*4 || mdecStatus(mdecCall(a.cvLock, p.buf, 1)) != 0 {
		return false
	}
	defer mdecCall(a.cvUnlock, p.buf, 1)
	stride := int(mdecCall(a.cvBytesPerRow, p.buf))
	base := mdecCall(a.cvBase, p.buf)
	if base == 0 || stride < p.w*4 || stride%4 != 0 {
		return false
	}
	src := mdecWords(base, stride/4*p.h)
	out := unsafe.Slice((*uint32)(unsafe.Pointer(&dst[0])), p.w*p.h)
	for y := 0; y < p.h; y++ {
		row, line := src[y*(stride/4):y*(stride/4)+p.w], out[y*p.w:(y+1)*p.w]
		for x, v := range row {
			line[x] = v&0xff00ff00 | v>>16&0xff | v&0xff<<16
		}
	}
	return true
}

func (p *macPicture) Release() {
	p.api.release(p.buf)
	p.buf = 0
}
