//go:build windows

// The mouse pointer in a captured picture. Neither Desktop Duplication nor a window's own drawing includes it, so it is read
// from the system and blended into the picture before it is encoded.
package native

import "unsafe"

const (
	cursorShowing = 1
	diNormal      = 3
	maxCursorEdge = 256
)

var (
	procGetCursorInfo = dllUser32.NewProc("GetCursorInfo")
	procGetIconInfo   = dllUser32.NewProc("GetIconInfo")
	procDrawIconEx    = dllUser32.NewProc("DrawIconEx")
)

type cursorInfo struct {
	size, flags uint32
	handle      uintptr
	x, y        int32
}

type iconInfo struct {
	icon       int32
	hotX, hotY uint32
	mask       uintptr
	color      uintptr
}

// bitmapObject is BITMAP.
type bitmapObject struct {
	kind, w, h, widthBytes int32
	planes, bitsPixel      uint16
	bits                   uintptr
}

// cursorShape is the picture of one pointer: BGRA with the colours not multiplied by the alpha.
type cursorShape struct {
	w, h, hotX, hotY int
	pix              []byte
}

// pointer reads the cursor and keeps the picture of the shape it has until it changes.
type pointer struct {
	handle uintptr
	shape  *cursorShape
}

// read is the pointer's shape and where its hot spot is on the screen, or false when it is hidden.
func (p *pointer) read() (shape *cursorShape, x, y int, ok bool) {
	info := cursorInfo{size: uint32(unsafe.Sizeof(cursorInfo{}))}
	if sys(procGetCursorInfo, uintptr(unsafe.Pointer(&info))) == 0 || info.flags&cursorShowing == 0 || info.handle == 0 {
		return nil, 0, 0, false
	}
	if info.handle != p.handle {
		p.handle, p.shape = info.handle, renderCursor(info.handle)
	}
	return p.shape, int(info.x), int(info.y), p.shape != nil
}

// renderCursor draws the pointer on black and then on white. A pixel over black is its colour times its alpha, and the two
// differ by what the alpha lets through of the white, which gives both back.
func renderCursor(handle uintptr) *cursorShape {
	var ii iconInfo
	if sys(procGetIconInfo, handle, uintptr(unsafe.Pointer(&ii))) == 0 {
		return nil
	}
	defer func() {
		for _, bmp := range []uintptr{ii.mask, ii.color} {
			if bmp != 0 {
				sys(procDeleteObject, bmp)
			}
		}
	}()
	source := ii.color
	if source == 0 {
		source = ii.mask
	}
	var bo bitmapObject
	if sys(procGetObjectW, source, unsafe.Sizeof(bo), uintptr(unsafe.Pointer(&bo))) == 0 {
		return nil
	}
	w, h := int(bo.w), int(bo.h)
	if ii.color == 0 {
		h /= 2 // a pointer of two colours keeps its AND mask over its XOR mask in one bitmap
	}
	if w <= 0 || h <= 0 || w > maxCursorEdge || h > maxCursorEdge {
		return nil
	}
	dark, err := newGDISurface(w, h)
	if err != nil {
		return nil
	}
	defer dark.close()
	light, err := newGDISurface(w, h)
	if err != nil {
		return nil
	}
	defer light.close()
	black, white := dark.pixels(), light.pixels()
	for i := range white {
		white[i] = 0xFF
	}
	sys(procDrawIconEx, dark.dc, 0, 0, handle, uintptr(w), uintptr(h), 0, 0, diNormal)
	sys(procDrawIconEx, light.dc, 0, 0, handle, uintptr(w), uintptr(h), 0, 0, diNormal)
	out := &cursorShape{w: w, h: h, hotX: int(ii.hotX), hotY: int(ii.hotY), pix: make([]byte, w*h*4)}
	for i := 0; i < w*h*4; i += 4 {
		alpha := 255 - (int(white[i+1]) - int(black[i+1]))
		if alpha <= 0 {
			continue
		}
		alpha = min(alpha, 255)
		for c := 0; c < 3; c++ {
			out.pix[i+c] = byte(min(int(black[i+c])*255/alpha, 255))
		}
		out.pix[i+3] = byte(alpha)
	}
	return out
}

// blend puts the shape on dst, a BGRA picture of w by h whose rows are stride bytes apart, with its hot spot at (x, y) in the
// picture's own pixels and the shape drawn scale times its size.
func (s *cursorShape) blend(dst []byte, stride, w, h, x, y int, scale float64) {
	cw, ch := max(1, int(float64(s.w)*scale+0.5)), max(1, int(float64(s.h)*scale+0.5))
	left, top := x-int(float64(s.hotX)*scale+0.5), y-int(float64(s.hotY)*scale+0.5)
	for dy := 0; dy < ch; dy++ {
		py := top + dy
		if py < 0 || py >= h {
			continue
		}
		row := s.pix[(dy*s.h/ch)*s.w*4:]
		for dx := 0; dx < cw; dx++ {
			px := left + dx
			if px < 0 || px >= w {
				continue
			}
			src := row[(dx*s.w/cw)*4 : (dx*s.w/cw)*4+4 : (dx*s.w/cw)*4+4]
			a := int(src[3])
			if a == 0 {
				continue
			}
			d := dst[py*stride+px*4 : py*stride+px*4+3 : py*stride+px*4+3]
			for c := 0; c < 3; c++ {
				d[c] = byte((int(d[c])*(255-a) + int(src[c])*a) / 255)
			}
		}
	}
}

// visible says where the pointer lands in a picture of w by h that shows the part of the screen starting at (originX,
// originY) at scale, and whether any of it does.
func (p *pointer) visible(originX, originY, w, h int, scale float64) (shape *cursorShape, x, y int, ok bool) {
	shape, sx, sy, ok := p.read()
	if !ok {
		return nil, 0, 0, false
	}
	x, y = int(float64(sx-originX)*scale+0.5), int(float64(sy-originY)*scale+0.5)
	reach := int(float64(max(shape.w, shape.h))*scale) + 1
	if x < -reach || y < -reach || x > w+reach || y > h+reach {
		return nil, 0, 0, false
	}
	return shape, x, y, true
}

