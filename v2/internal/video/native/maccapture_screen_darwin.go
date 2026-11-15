//go:build darwin

package native

// Screen capture with ScreenCaptureKit: one display, scaled and converted to 420v in the compositor at the stream's size,
// handed to the encoder without a copy.

import (
	"errors"
	"fmt"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

const screenPermission = "Screen recording is not allowed for this program. Allow it in System Settings > Privacy & Security > Screen & System Audio Recording, then share again."

const (
	mcSCStreamErrorUserDeclined = -3801
	mcSCOutputScreen            = 0
)

func (c *macCapture) startScreen() error {
	sck, err := purego.Dlopen("/System/Library/Frameworks/ScreenCaptureKit.framework/ScreenCaptureKit", purego.RTLD_LAZY|purego.RTLD_GLOBAL)
	if err != nil {
		return fmt.Errorf("ScreenCaptureKit is not available: %w", err)
	}
	c.status = uintptr(mcConstant(sck, "SCStreamFrameInfoStatus"))
	filter, dw, dh, err := mcFilter(c.p.SourceID, c.p.Display)
	if err != nil {
		return err
	}
	th := mxEven(c.p.Height)
	if scale := objc.Send[float32](filter, objc.RegisterName("pointPixelScale")); c.p.Native && scale >= 1 {
		th = mxEven(min(2160, int(float32(dh)*scale)))
	}
	tw := mxEven((th*dw + dh/2) / dh)
	enc, err := newCaptureEncoder(c.encodeParams(tw, th), c.onAU)
	if err != nil {
		mcRelease(filter)
		return err
	}
	c.enc.Store(enc)

	cfg := mcNewObject("SCStreamConfiguration")
	cfg.Send(objc.RegisterName("setWidth:"), uint(tw))
	cfg.Send(objc.RegisterName("setHeight:"), uint(th))
	mc.msgSendTime(cfg, objc.RegisterName("setMinimumFrameInterval:"), cmTime{Value: 1, Scale: int32(c.p.FPS), Flags: 1})
	cfg.Send(objc.RegisterName("setPixelFormat:"), uint32(mxFmt420v))
	cfg.Send(objc.RegisterName("setQueueDepth:"), 5)
	cfg.Send(objc.RegisterName("setShowsCursor:"), true)
	matrix := mx.vMat601
	if c.p.Matrix == BT709 {
		matrix = mx.vMat709
	}
	cfg.Send(objc.RegisterName("setColorMatrix:"), matrix)
	cfg.Send(objc.RegisterName("setColorSpaceName:"), mx.kSRGB)

	sink := objc.ID(mc.sink).Send(mc.selAlloc).Send(mc.selInit)
	mcSinks.Store(sink, c)
	queue := mcQueue("harmony.capture.screen")
	stream := mcClass("SCStream").Send(mc.selAlloc).Send(objc.RegisterName("initWithFilter:configuration:delegate:"), filter, cfg, sink)
	if stream == 0 {
		mcSinks.Delete(sink)
		return errors.New("ScreenCaptureKit could not make a stream")
	}
	teardown := func() {
		mcSinks.Delete(sink)
		for _, o := range []objc.ID{stream, filter, cfg, sink, queue} {
			mcRelease(o)
		}
	}
	addErr := mcErrCell()
	if !objc.Send[bool](stream, objc.RegisterName("addStreamOutput:type:sampleHandlerQueue:error:"), sink, mcSCOutputScreen, queue, unsafe.Pointer(addErr)) {
		teardown()
		return fmt.Errorf("ScreenCaptureKit refused the output: %s", mcErrorText(*addErr))
	}
	started := make(chan string, 1)
	blk := objc.NewBlock(func(_ objc.Block, err objc.ID) { started <- mcErrorOrEmpty(err) })
	stream.Send(objc.RegisterName("startCaptureWithCompletionHandler:"), blk)
	msg, werr := mcWait(started, 10*time.Second, "ScreenCaptureKit")
	blk.Release()
	if werr != nil {
		teardown()
		return werr
	}
	if msg != "" {
		teardown()
		return errors.New(msg)
	}
	c.stop = func() {
		done := make(chan struct{}, 1)
		b := objc.NewBlock(func(objc.Block, objc.ID) { done <- struct{}{} })
		stream.Send(objc.RegisterName("stopCaptureWithCompletionHandler:"), b)
		mcWait(done, 3*time.Second, "ScreenCaptureKit stop")
		b.Release()
		teardown()
	}
	return nil
}

// mcErrorOrEmpty is "" for no error, the permission text for a refusal, and the system's words otherwise.
func mcErrorOrEmpty(err objc.ID) string {
	if err == 0 {
		return ""
	}
	if objc.Send[int](err, mc.selCode) == mcSCStreamErrorUserDeclined {
		return screenPermission
	}
	return "ScreenCaptureKit: " + mcErrorText(err)
}
