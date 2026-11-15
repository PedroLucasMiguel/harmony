//go:build darwin

package native

// What a camera offers, from AVCaptureDevice.formats: the sizes, and the most frames a second each is kept at.

import (
	"sync"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

// macFormat is one AVCaptureDeviceFormat.
type macFormat struct {
	obj  objc.ID
	w, h int
	fps  float64
}

var mcDimensions struct {
	once sync.Once
	fn   func(desc uintptr) uint64
}

func mcFormatSize(desc objc.ID) (w, h int) {
	mcDimensions.once.Do(func() {
		purego.RegisterLibFunc(&mcDimensions.fn, mx.cm, "CMVideoFormatDescriptionGetDimensions")
	})
	packed := mcDimensions.fn(uintptr(desc))
	return int(int32(packed)), int(int32(packed >> 32))
}

// mcCameraDevice is the camera with this unique ID, or the default one for "".
func mcCameraDevice(id string) objc.ID {
	if id == "" {
		return mcDeviceClass().Send(objc.RegisterName("defaultDeviceWithMediaType:"), mcVideoType())
	}
	return mcDeviceClass().Send(objc.RegisterName("deviceWithUniqueID:"), mcNSString(id))
}

func mcDeviceFormats(dev objc.ID) []macFormat {
	rangesSel, maxSel, descSel := objc.RegisterName("videoSupportedFrameRateRanges"), objc.RegisterName("maxFrameRate"), objc.RegisterName("formatDescription")
	var out []macFormat
	for _, f := range mcArray(objc.Send[objc.ID](dev, objc.RegisterName("formats"))) {
		w, h := mcFormatSize(objc.Send[objc.ID](f, descSel))
		if w <= 0 || h <= 0 {
			continue
		}
		fps := 0.0
		for _, r := range mcArray(objc.Send[objc.ID](f, rangesSel)) {
			fps = max(fps, objc.Send[float64](r, maxSel))
		}
		out = append(out, macFormat{obj: f, w: w, h: h, fps: fps})
	}
	return out
}

func listCameraFormats(id string) []CameraFormat {
	if mcLoad() != nil {
		return nil
	}
	defer mcPool()()
	dev := mcCameraDevice(id)
	if dev == 0 {
		return nil
	}
	var out []CameraFormat
	for _, f := range mcDeviceFormats(dev) {
		out = append(out, CameraFormat{W: f.w, H: f.h, MaxFPS: f.fps})
	}
	return out
}

// mcChooseFormat is the smallest format that has at least wantH lines and keeps wantFPS, else the one that comes nearest.
func mcChooseFormat(formats []macFormat, wantH, wantFPS int) (macFormat, bool) {
	var best macFormat
	found := false
	for _, f := range formats {
		if f.h < wantH || f.fps < float64(wantFPS) {
			continue
		}
		if !found || f.w*f.h < best.w*best.h {
			best, found = f, true
		}
	}
	return best, found
}

// mcSetActiveFormat puts the camera in a format the session presets do not reach (above 1080 lines).
func mcSetActiveFormat(dev objc.ID, f macFormat) bool {
	var lockErr objc.ID
	if !objc.Send[bool](dev, objc.RegisterName("lockForConfiguration:"), &lockErr) {
		return false
	}
	dev.Send(objc.RegisterName("setActiveFormat:"), f.obj)
	dev.Send(objc.RegisterName("unlockForConfiguration"))
	return true
}
