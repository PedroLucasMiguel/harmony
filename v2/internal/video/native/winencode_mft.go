//go:build windows

// Finding and configuring the H.264 encoder transform: hardware ones by vendor, Microsoft's software one, the media
// types, the low delay settings through ICodecAPI.
package native

import (
	"fmt"
	"unsafe"
)

// encCandidate is one encoder transform that can be tried.
type encCandidate struct {
	backend  string // Backend ID: nvidia, amd, intel or software
	name     string
	activate mfActivate // zero for the software encoder
}

// hardwareEncoders lists the hardware H.264 encoder transforms in the order Media Foundation ranks them. The activates
// are the caller's to release.
func hardwareEncoders() []encCandidate {
	in := &mftRegisterTypeInfo{guidMediaTypeVideo, guidVideoNV12}
	out := &mftRegisterTypeInfo{guidMediaTypeVideo, guidVideoH264}
	acts, err := mftEnumEx(&guidCategoryEnc, mftEnumHardware|mftEnumSortFilter, in, out)
	if err != nil {
		return nil
	}
	var list []encCandidate
	for _, a := range acts {
		id, _, _ := a.getString(&mftHardwareVendorID)
		backend := vendorBackend(parseVendorID(id))
		name, _, _ := a.getString(&mftFriendlyName)
		if backend == "" {
			a.release()
			continue
		}
		list = append(list, encCandidate{backend: backend, name: name, activate: a})
	}
	return list
}

// encoderCandidates is what to try for a Backend setting, best first.
func encoderCandidates(backend string) ([]encCandidate, error) {
	software := encCandidate{backend: Software, name: "Microsoft H.264 Encoder"}
	switch backend {
	case Software:
		return []encCandidate{software}, nil
	case Auto:
		return append(hardwareEncoders(), software), nil
	case NVIDIA, AMD, Intel:
		var list []encCandidate
		for _, c := range hardwareEncoders() {
			if c.backend == backend {
				list = append(list, c)
			} else {
				c.activate.release()
			}
		}
		if len(list) == 0 {
			return nil, fmt.Errorf("no %s hardware H.264 encoder: install or update the graphics driver", backend)
		}
		return list, nil
	}
	return nil, fmt.Errorf("unknown encoder %q", backend)
}

func releaseCandidates(list []encCandidate) {
	for _, c := range list {
		if c.activate.com != 0 {
			c.activate.release()
		}
	}
}

// h264Profiles is the order a profile is asked for, as the Electron client's codec preference has it: High, Main, then
// constrained baseline (eAVEncH264VProfile_High, _Main, _Base). An encoder that refuses one is asked for the next.
var h264Profiles = []uint32{100, 77, 66}

var profileNames = map[uint32]string{100: "high", 77: "main", 66: "constrained baseline"}

// variant is the VARIANT of ICodecAPI::SetValue: 24 bytes on 64-bit Windows.
type variant struct {
	vt  uint16
	_   [3]uint16
	val uint64
	_   uint64
}

const (
	vtBool = 11
	vtUI4  = 19
)

// codecAPI is the ICodecAPI of a transform.
type codecAPI struct{ com }

// set stores one setting; v is scratch the caller keeps on the heap.
func (c codecAPI) set(v *variant, key *guid, vt uint16, val uint64) hresult {
	*v = variant{vt: vt, val: val}
	return c.call(9, key.p(), uintptr(unsafe.Pointer(v)))
}

func (c codecAPI) setUI4(v *variant, key *guid, val uint32) hresult {
	return c.set(v, key, vtUI4, uint64(val))
}
func (c codecAPI) setBool(v *variant, key *guid, on bool) hresult {
	if on {
		return c.set(v, key, vtBool, 0xFFFF)
	}
	return c.set(v, key, vtBool, 0)
}

// open makes the transform, tells it the stream and starts it. The settings that only some encoders have are tried and
// left when refused: what matters is that the stream comes out as the contract says, and that is checked in the output.
func (e *mftEncoder) open(c encCandidate) error {
	var obj com
	var err error
	if c.activate.com != 0 {
		obj, err = c.activate.activate(&iidIMFTransform)
	} else {
		obj, err = coCreateInstance(&clsidMSH264EncoderMFT, &iidIMFTransform)
	}
	if err != nil {
		return fmt.Errorf("%s: %w", c.name, err)
	}
	e.mft = mfTransform{obj}
	e.act = c.activate
	e.name = c.name
	e.candBackend = c.backend
	if err := e.configure(); err != nil {
		return fmt.Errorf("%s: %w", c.name, err)
	}
	return nil
}

func (e *mftEncoder) configure() error {
	t := e.mft
	if attrs, ok := t.attributes(); ok {
		if v, found, _ := attrs.getUINT32(&mfTransformAsync); found && v == 1 {
			e.async = true
			if err := attrs.setUINT32(&mfTransformAsyncUnlk, 1); err != nil {
				return err
			}
		}
		attrs.setUINT32(&mfLowLatency, 1)
		attrs.release()
	}
	if e.gpuIn != nil && e.async {
		e.gpu = e.attachDevice() == nil
	}
	if e.async {
		gen, err := t.queryInterface(&iidIMFMediaEventGen)
		if err != nil {
			return err
		}
		e.events = mfEventGenerator{gen}
	}
	if api, err := t.queryInterface(&iidICodecAPI); err == nil {
		e.codec = codecAPI{api}
		v := &e.setVar
		e.codec.setUI4(v, &codecRateControlMode, rateControlCBR)
		e.codec.setUI4(v, &codecMeanBitRate, uint32(e.bitrate)*1000)
		e.codec.setBool(v, &codecLowLatency, true)
		e.codec.setUI4(v, &codecBPictureCount, 0)
		e.codec.setUI4(v, &codecGOPSize, uint32(e.fps*2))
		e.codec.setBool(v, &codecRealTime, true)
	}

	var err error
	for _, profile := range h264Profiles {
		if err = e.setOutput(profile); err == nil {
			e.profile = profile
			break
		}
	}
	if err != nil {
		return err
	}
	if err := e.setInput(true); err != nil {
		if err2 := e.setInput(false); err2 != nil {
			return err
		}
	}
	if e.codec.com != 0 {
		e.codec.setUI4(&e.setVar, &codecMeanBitRate, uint32(e.bitrate)*1000)
	}

	var info mftOutputStreamInfo
	if err := t.outputStreamInfo(&info); err != nil {
		return err
	}
	e.provides = info.flags&(mftOutProvides|mftOutCanProvide) != 0
	if !e.provides {
		size := max(int(info.size), e.w*e.h)
		if e.outBuf, err = mfCreateMemoryBuffer(size); err != nil {
			return err
		}
		if e.outSample, err = mfCreateSample(); err != nil {
			return err
		}
		if err := e.outSample.addBuffer(e.outBuf); err != nil {
			return err
		}
	}
	for i := range e.pool {
		p := &e.pool[i]
		if e.gpu {
			p.buf, err = mfCreateDXGISurfaceBuffer(e.gpuIn.tex[i])
		} else {
			p.buf, err = mfCreateMemoryBuffer(e.size)
		}
		if err != nil {
			return err
		}
		if p.sample, err = mfCreateSample(); err != nil {
			return err
		}
		if err := p.sample.addBuffer(p.buf); err != nil {
			return err
		}
	}
	if hr := t.processMessage(mftMsgBeginStream, 0); hr.failed() {
		return hr.err("NOTIFY_BEGIN_STREAMING")
	}
	if hr := t.processMessage(mftMsgStartStream, 0); hr.failed() {
		return hr.err("NOTIFY_START_OF_STREAM")
	}
	return nil
}

// setOutput gives the transform the H.264 output type with the profile asked for.
func (e *mftEncoder) setOutput(profile uint32) error {
	out, err := e.mediaType(&guidVideoH264)
	if err != nil {
		return err
	}
	defer out.release()
	if err := out.setUINT32(&weMTAvgBitrate, uint32(e.bitrate)*1000); err != nil {
		return err
	}
	if err := out.setUINT32(&weMTMPEG2Profile, profile); err != nil {
		return err
	}
	if e.codec.com != 0 {
		e.codec.setUI4(&e.setVar, &codecProfile, profile)
	}
	return e.mft.setOutputType(out)
}

// mediaType makes a video type of the stream's size and rate.
func (e *mftEncoder) mediaType(sub *guid) (mfMediaType, error) {
	mt, err := mfCreateMediaType()
	if err != nil {
		return mt, err
	}
	for _, step := range []func() error{
		func() error { return mt.setGUID(&mfMTMajorType, &guidMediaTypeVideo) },
		func() error { return mt.setGUID(&mfMTSubtype, sub) },
		func() error { return mt.setSize(e.w, e.h) },
		func() error { return mt.setRatio(&mfMTFrameRate, e.fps, 1) },
		func() error { return mt.setRatio(&weMTPixelAspect, 1, 1) },
		func() error { return mt.setUINT32(&mfMTInterlaceMode, mfInterlaceProgressive) },
	} {
		if err := step(); err != nil {
			mt.release()
			return mfMediaType{}, err
		}
	}
	return mt, nil
}

// setInput gives the transform the NV12 type, with the colour description when asked: not every encoder takes the
// attributes, and the tag in the stream is written by this package either way.
func (e *mftEncoder) setInput(withColour bool) error {
	in, err := e.mediaType(&guidVideoNV12)
	if err != nil {
		return err
	}
	defer in.release()
	if withColour {
		primaries, matrix := uint32(mfPrimariesSMPTE170M), uint32(mfMatrixBT601)
		if e.matrix == BT709 {
			primaries, matrix = mfPrimariesBT709, mfMatrixBT709
		}
		in.setUINT32(&weMTVideoPrimaries, primaries)
		in.setUINT32(&weMTTransferFunc, mfTransferBT709)
		in.setUINT32(&mfMTYUVMatrix, matrix)
		in.setUINT32(&mfMTVideoNominalRng, mfRange16To235)
	}
	return e.mft.setInputType(in)
}
