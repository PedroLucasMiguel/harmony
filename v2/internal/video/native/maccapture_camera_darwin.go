//go:build darwin

package native

// The camera through AVFoundation: an AVCaptureSession with a video data output in 420v. The first picture sizes the
// encoder; a picture of another size or matrix than the stream's is scaled and converted on the GPU by the encoder.

import (
	"errors"
	"fmt"
	"time"

	"github.com/ebitengine/purego/objc"
)

const cameraPermission = "Camera access is not allowed for this program. Allow it in System Settings > Privacy & Security > Camera, then start the camera again."

const (
	mcAuthNotDetermined = 0
	mcAuthAuthorized    = 3
)

var mcCameraTypes = []string{
	"AVCaptureDeviceTypeBuiltInWideAngleCamera", "AVCaptureDeviceTypeExternal", "AVCaptureDeviceTypeContinuityCamera",
	"AVCaptureDeviceTypeDeskViewCamera",
}

func mcDeviceClass() objc.ID { return mcClass("AVCaptureDevice") }

func mcVideoType() objc.ID { return mcConstant(mc.avf, "AVMediaTypeVideo") }

func listCameras() []CameraInfo {
	if mcLoad() != nil {
		return nil
	}
	defer mcPool()()
	var types []objc.ID
	for _, n := range mcCameraTypes {
		if t := mcConstant(mc.avf, n); t != 0 {
			types = append(types, t)
		}
	}
	if len(types) == 0 {
		return nil
	}
	disc := mcClass("AVCaptureDeviceDiscoverySession").Send(objc.RegisterName("discoverySessionWithDeviceTypes:mediaType:position:"),
		mcNSArray(types...), mcVideoType(), 0)
	if disc == 0 {
		return nil
	}
	idSel, nameSel := objc.RegisterName("uniqueID"), objc.RegisterName("localizedName")
	def := ""
	if d := mcDeviceClass().Send(objc.RegisterName("defaultDeviceWithMediaType:"), mcVideoType()); d != 0 {
		def = mcGoString(d.Send(idSel))
	}
	var out []CameraInfo
	for _, d := range mcArray(objc.Send[objc.ID](disc, objc.RegisterName("devices"))) {
		info := CameraInfo{ID: mcGoString(d.Send(idSel)), Name: mcGoString(d.Send(nameSel))}
		if info.ID == def && len(out) > 0 {
			out = append([]CameraInfo{info}, out...)
		} else {
			out = append(out, info)
		}
	}
	return out
}

// mcCameraAccess returns nil when the program may use the camera, asking the user when they have not been asked.
func mcCameraAccess() error {
	status := objc.Send[int](mcDeviceClass(), objc.RegisterName("authorizationStatusForMediaType:"), mcVideoType())
	switch status {
	case mcAuthAuthorized:
		return nil
	case mcAuthNotDetermined:
		ch := make(chan bool, 1)
		blk := objc.NewBlock(func(_ objc.Block, granted bool) { ch <- granted })
		mcDeviceClass().Send(objc.RegisterName("requestAccessForMediaType:completionHandler:"), mcVideoType(), blk)
		granted, err := mcWait(ch, 2*time.Minute, "the camera permission question")
		blk.Release()
		if err != nil {
			return err
		}
		if granted {
			return nil
		}
	}
	return errors.New(cameraPermission)
}

func (c *macCapture) startCamera() error {
	if err := mcCameraAccess(); err != nil {
		return err
	}
	var dev objc.ID
	if c.p.CameraID == "" {
		dev = mcDeviceClass().Send(objc.RegisterName("defaultDeviceWithMediaType:"), mcVideoType())
	} else {
		dev = mcDeviceClass().Send(objc.RegisterName("deviceWithUniqueID:"), mcNSString(c.p.CameraID))
	}
	if dev == 0 {
		return errors.New("there is no camera to use")
	}
	inErr := mcErrCell()
	input := mcClass("AVCaptureDeviceInput").Send(objc.RegisterName("deviceInputWithDevice:error:"), dev, inErr)
	if input == 0 {
		return fmt.Errorf("the camera cannot be opened: %s", mcErrorText(*inErr))
	}
	session := mcNewObject("AVCaptureSession")
	preset := "AVCaptureSessionPreset1280x720"
	if c.p.Height > 720 {
		preset = "AVCaptureSessionPreset1920x1080"
	}
	if c.p.Height > 1080 {
		// beyond the presets: the camera's own biggest format that keeps the rate
		if f, ok := mcChooseFormat(mcDeviceFormats(dev), c.p.Height, c.p.FPS); ok && mcSetActiveFormat(dev, f) {
			preset = "AVCaptureSessionPresetInputPriority"
		}
	}
	if p := mcConstant(mc.avf, preset); p != 0 && objc.Send[bool](session, objc.RegisterName("canSetSessionPreset:"), p) {
		session.Send(objc.RegisterName("setSessionPreset:"), p)
	}
	if !objc.Send[bool](session, objc.RegisterName("canAddInput:"), input) {
		mcRelease(session)
		return errors.New("the camera is in use and cannot be shared")
	}
	session.Send(objc.RegisterName("addInput:"), input)

	output := mcNewObject("AVCaptureVideoDataOutput")
	output.Send(objc.RegisterName("setAlwaysDiscardsLateVideoFrames:"), true)
	settings := mcNSDictionary([]objc.ID{objc.ID(mx.kPBFormat)}, []objc.ID{mcNSNumber(mxFmt420v)})
	output.Send(objc.RegisterName("setVideoSettings:"), settings)
	sink := objc.ID(mc.sink).Send(mc.selAlloc).Send(mc.selInit)
	mcSinks.Store(sink, c)
	queue := mcQueue("harmony.capture.camera")
	output.Send(objc.RegisterName("setSampleBufferDelegate:queue:"), sink, queue)
	if !objc.Send[bool](session, objc.RegisterName("canAddOutput:"), output) {
		mcSinks.Delete(sink)
		for _, o := range []objc.ID{output, session, sink, queue} {
			mcRelease(o)
		}
		return errors.New("the camera session refused the video output")
	}
	session.Send(objc.RegisterName("addOutput:"), output)

	lost := func() { c.end(errors.New("the camera stopped")) }
	t1, b1 := mcObserve(mcConstant(mc.avf, "AVCaptureDeviceWasDisconnectedNotification"), dev, lost)
	t2, b2 := mcObserve(mcConstant(mc.avf, "AVCaptureSessionRuntimeErrorNotification"), session, lost)
	c.stop = func() {
		mcUnobserve(t1, b1)
		mcUnobserve(t2, b2)
		session.Send(objc.RegisterName("stopRunning"))
		output.Send(objc.RegisterName("setSampleBufferDelegate:queue:"), objc.ID(0), objc.ID(0))
		mcSinks.Delete(sink)
		for _, o := range []objc.ID{output, session, sink, queue} {
			mcRelease(o)
		}
	}
	session.Send(objc.RegisterName("startRunning"))
	err, werr := mcWait(c.first, 10*time.Second, "the camera")
	if werr != nil {
		return errors.New("the camera gave no picture: it may be in use by another program or switched off")
	}
	return err
}
