//go:build linux

package native

// One VA-API decode session: the config, context and surfaces for a sequence parameter set, submitting the pictures and
// reading the decoded surfaces back as NV12.

import (
	"fmt"
	"unsafe"
)

type vdSession struct {
	d        *vaDisplay
	sps      *vdSPS
	cfg      vaConfigID
	ctx      vaContextID
	surfaces []vaSurfaceID
	// image is the cached system memory picture vaGetImage fills; with none, surfaces are mapped directly.
	image  vaImage
	hasImg bool
	derive bool
	bufs   []vaBufferID
}

// vdProfiles lists the VA profiles that can decode the stream, the closest first.
func vdProfiles(sps *vdSPS) []int32 {
	switch {
	case sps.profile == 66 || sps.profile == 77 && sps.constraints&0x40 != 0:
		return []int32{vaProfileH264ConstrainedBaseline, vaProfileH264Main, vaProfileH264High}
	case sps.profile == 77 || sps.profile == 88:
		return []int32{vaProfileH264Main, vaProfileH264High}
	}
	return []int32{vaProfileH264High}
}

func openVDSession(d *vaDisplay, sps *vdSPS, surfaces int) (*vdSession, error) {
	s := &vdSession{d: d, sps: sps}
	profile := int32(-1)
	for _, p := range vdProfiles(sps) {
		if d.hasEntrypoint(p, vaEntrypointVLD) {
			profile = p
			break
		}
	}
	if profile < 0 {
		return nil, fmt.Errorf("the VA-API driver (%s) cannot decode H.264 profile %d: %s", d.Vendor, sps.profile, vaDriverHint(d.Node.Vendor))
	}
	attribs := []vaConfigAttrib{{Type: vaConfigAttribRTFormat, Value: vaRTFormatYUV420}}
	cfg, err := d.createConfig(profile, vaEntrypointVLD, attribs)
	if err != nil {
		return nil, err
	}
	s.cfg = cfg
	w, h := sps.width(), sps.height()
	if s.surfaces, err = d.createSurfaces(vaRTFormatYUV420, w, h, surfaces, 0); err != nil {
		s.Close()
		return nil, err
	}
	if s.ctx, err = d.createContext(cfg, w, h, s.surfaces); err != nil {
		d.destroySurfaces(s.surfaces)
		s.surfaces = nil
		s.Close()
		return nil, err
	}
	if format, ok := d.imageFormat(vaFourccNV12); ok {
		if d.createImage(&format, w, h, &s.image) == nil {
			s.hasImg = true
		}
	}
	s.derive = !s.hasImg
	return s, nil
}

func (s *vdSession) Close() {
	if s.hasImg {
		s.d.destroyImage(s.image.ImageID)
		s.hasImg = false
	}
	if s.ctx != 0 {
		s.d.destroyContext(s.ctx)
		s.ctx = 0
	}
	s.d.destroySurfaces(s.surfaces)
	s.surfaces = nil
	if s.cfg != 0 {
		s.d.destroyConfig(s.cfg)
		s.cfg = 0
	}
}

// buffer makes a parameter or data buffer that submit destroys when it is done.
func (s *vdSession) buffer(typ int32, p unsafe.Pointer, size int) (vaBufferID, error) {
	id, err := s.d.createBuffer(s.ctx, typ, size, 1, p)
	if err == nil {
		s.bufs = append(s.bufs, id)
	}
	return id, err
}

func (s *vdSession) destroyBuffers() {
	for _, b := range s.bufs {
		s.d.destroyBuffer(b)
	}
	s.bufs = s.bufs[:0]
}

// submit decodes the picture on the target surface.
func (s *vdSession) submit(target vaSurfaceID, picture *vaPictureParameterBufferH264, iq *vaIQMatrixBufferH264, sl *vdSlices) error {
	d := s.d
	defer s.destroyBuffers()
	pic, err := s.buffer(vaPictureParameterBufferType, unsafe.Pointer(picture), int(unsafe.Sizeof(*picture)))
	if err != nil {
		return err
	}
	iqBuf, err := s.buffer(vaIQMatrixBufferType, unsafe.Pointer(iq), int(unsafe.Sizeof(*iq)))
	if err != nil {
		return err
	}
	if err := d.beginPicture(s.ctx, target); err != nil {
		return err
	}
	if err := s.render(pic, iqBuf, sl); err != nil {
		d.endPicture(s.ctx)
		return err
	}
	return d.endPicture(s.ctx)
}

func (s *vdSession) render(pic, iq vaBufferID, sl *vdSlices) error {
	d := s.d
	if err := d.renderPicture(s.ctx, pic, iq); err != nil {
		return err
	}
	offset := 0
	for i := range sl.params {
		size := sl.sizes[i]
		sp, err := s.buffer(vaSliceParameterBufferType, unsafe.Pointer(&sl.params[i]), int(unsafe.Sizeof(sl.params[i])))
		if err != nil {
			return err
		}
		sd, err := s.buffer(vaSliceDataBufferType, unsafe.Pointer(&sl.data[offset]), size)
		if err != nil {
			return err
		}
		offset += size
		if err := d.renderPicture(s.ctx, sp, sd); err != nil {
			return err
		}
	}
	return nil
}

// vdMapped is a decoded picture in memory: planes valid until unmap.
type vdMapped struct {
	y, uv         []byte
	yPitch, uvPit int
	buf           vaBufferID
	image         vaImage
	derived       bool
}

// readback waits for the surface and maps its NV12 contents.
func (s *vdSession) readback(surface vaSurfaceID, m *vdMapped) error {
	d := s.d
	if err := d.syncSurface(surface); err != nil {
		return err
	}
	w, h := s.sps.width(), s.sps.height()
	if !s.derive {
		if err := d.getImage(surface, w, h, s.image.ImageID); err != nil {
			s.derive = true
			return s.readback(surface, m)
		}
		m.image, m.derived = s.image, false
	} else {
		if err := d.deriveImage(surface, &m.image); err != nil {
			return err
		}
		m.derived = true
	}
	img := &m.image
	if img.Format.Fourcc != vaFourccNV12 || img.NumPlanes < 2 || int(img.Width) < w || int(img.Height) < h {
		s.unmapImage(m, false)
		return fmt.Errorf("VA-API gave a picture that is not NV12 of the size asked (fourcc %#x, %d planes)", img.Format.Fourcc, img.NumPlanes)
	}
	p, err := d.mapBuffer(img.Buf)
	if err != nil {
		s.unmapImage(m, false)
		return err
	}
	m.buf = img.Buf
	all := unsafe.Slice((*byte)(p), img.DataSize)
	m.yPitch, m.uvPit = int(img.Pitches[0]), int(img.Pitches[1])
	if int(img.Offsets[1]) > len(all) || int(img.Offsets[0]) > len(all) {
		s.unmap(m)
		return fmt.Errorf("VA-API gave a picture with planes outside its buffer")
	}
	m.y, m.uv = all[img.Offsets[0]:], all[img.Offsets[1]:]
	return nil
}

func (s *vdSession) unmapImage(m *vdMapped, unmap bool) {
	if unmap {
		s.d.unmapBuffer(m.buf)
	}
	if m.derived {
		s.d.destroyImage(m.image.ImageID)
		m.derived = false
	}
}

func (s *vdSession) unmap(m *vdMapped) { s.unmapImage(m, true) }
