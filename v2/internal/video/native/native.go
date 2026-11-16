// Package native is the system's own video: H.264 decode and encode in the graphics hardware, and screen and camera
// capture, through the operating system's frameworks (VideoToolbox and ScreenCaptureKit on macOS, Media Foundation and
// DXGI on Windows, VA-API and PipeWire on Linux). Nothing here starts another process or needs a library that is not part
// of the system. One file per job per platform: decode_<os>.go, encode_<os>.go, capture_<os>.go.
package native

import (
	"errors"
	"runtime"
)

// ErrUnsupported is returned where the platform has no way to do the job (no hardware codec, no capture API).
var ErrUnsupported = errors.New("not supported on this system")

// H.273 matrix coefficient codes, the ones this client uses.
const (
	BT709 = 1
	BT601 = 6
)

// DecodeParams say what pictures are wanted from a stream.
type DecodeParams struct {
	// Width and Height are the size the pictures are made at: the stream is scaled to it (never enlarged past what was sent).
	Width, Height int
	// Matrix and Full say how the stream codes colour when its own parameter sets do not (an H.273 matrix code and whether
	// the range is full); what the stream says wins.
	Matrix int
	Full   bool
	// Backend picks the codec: "" (automatic: the graphics hardware, the software decoder only when there is none), or an
	// ID from Decoders(): "videotoolbox", "nvidia", "amd", "intel" or "software".
	Backend string
}

// Decoder turns an H.264 stream into RGBA pictures.
type Decoder interface {
	// Write takes one Annex B access unit and returns at once. needKeyframe is true when the decoder has lost its place
	// and cannot show pictures until the next key frame.
	Write(au []byte) (needKeyframe bool)
	// Mode names the codec in use: "videotoolbox", "mediafoundation" or "vaapi".
	Mode() string
	Close()
}

// NewDecoder starts a decoder. onPicture is called from the decoder's own goroutine with a tightly packed RGBA picture
// (w*h*4 bytes) that is valid only during the call.
func NewDecoder(p DecodeParams, onPicture func(rgba []byte, w, h int)) (Decoder, error) {
	return newDecoder(p, onPicture)
}

// EncodeParams say what stream is made.
type EncodeParams struct {
	Width, Height int
	FPS           int
	BitrateKbps   int
	// Matrix is the H.273 matrix code the RGB input is converted with and the stream is tagged with (BT709 or BT601).
	Matrix int
	// Backend picks the codec: "" (automatic: the graphics hardware, the software encoder only when there is none), or an
	// ID from Encoders(): "videotoolbox", "nvidia" (NVENC), "amd", "intel" or "software". A backend the system does not have
	// is an error, not a silent switch: the caller decides whether to fall back to "".
	Backend string
}

// Encoder turns pictures into an H.264 stream: constrained baseline or main, no B frames, low delay, a key frame every
// two seconds, SPS and PPS in front of every key frame, the colour coding in the VUI.
type Encoder interface {
	// EncodeBGRA takes one picture of the encoder's size, 4 bytes a pixel in B, G, R, A order, stride bytes a row. The
	// encoder does not keep pix after it returns.
	EncodeBGRA(pix []byte, stride int) error
	// KeyFrame makes the next picture a key frame.
	KeyFrame()
	// Mode names the codec in use, for the log.
	Mode() string
	Close()
}

// NewEncoder starts an encoder. onAU is called from the encoder's own goroutine with one Annex B access unit that is valid
// only during the call.
func NewEncoder(p EncodeParams, onAU func(au []byte)) (Encoder, error) {
	return newEncoder(p, onAU)
}

// Source is what a capture takes pictures of.
type Source string

const (
	Screen Source = "screen"
	Webcam Source = "camera"
)

// CaptureParams say what is captured and how it is sent.
type CaptureParams struct {
	Source Source
	// Display is the index of the screen for Screen, 0 the main one.
	Display int
	// SourceID is a SourceInfo.ID of a screen or window and wins over Display; "" is the Display.
	SourceID string
	// CameraID is a Camera.ID, or "" for the default camera.
	CameraID string
	// Height is the height of the stream; the width follows the source's shape, rounded to an even number.
	Height int
	// Native asks a screen or window for its own size in pixels (at most 2160 lines) where the system can say it; Height is
	// then only what other systems use.
	Native      bool
	FPS         int
	BitrateKbps int
	Matrix      int
	// Backend is the encoder, as in EncodeParams.
	Backend string
}

// Capture is a running capture, encoded.
type Capture interface {
	Mode() string
	Close()
}

// StartCapture opens the screen or camera and starts sending access units to onAU (valid only during the call; a
// picture the encoder is too slow for is dropped, never queued). It returns an error at once when the device cannot be
// opened or the user has not allowed it. onEnd is called once, from another goroutine, if the capture stops by itself
// (the camera was unplugged, the permission was taken away); it is not called after Close.
func StartCapture(p CaptureParams, onAU func(au []byte), onEnd func(error)) (Capture, error) {
	if kind, _ := ParseSourceID(p.SourceID); kind == KindWindow && runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		return nil, ErrUnsupported
	}
	if n, ok := parseSourceNumber(p.SourceID, KindScreen); ok && runtime.GOOS != "darwin" {
		p.Display = int(n)
	}
	return startCapture(p, onAU, onEnd)
}

// EncodeStats are running totals of a capture's encoder: the access units made, the seconds spent on them from handing a
// picture over to getting its unit back, and the pictures dropped because the encoder was still busy.
type EncodeStats struct {
	Frames        uint64
	EncodeSeconds float64
	Dropped       uint64
}

// StatsReader is a Capture that can say how its encoder is doing.
type StatsReader interface{ Stats() EncodeStats }

// CameraInfo is a camera the system has.
type CameraInfo struct {
	ID   string
	Name string
}

// Cameras lists the cameras the system has, the default one first; nil when there are none or the system cannot say.
func Cameras() []CameraInfo { return listCameras() }

// CameraFormat is a picture size a camera offers and the most frames a second it keeps at that size.
type CameraFormat struct {
	W, H   int
	MaxFPS float64
}

// CameraFormats lists what the camera with this ID (the default one for "") can do; nil when the system cannot say. Ask
// before the camera is opened: some systems let only one program hold a camera.
func CameraFormats(id string) []CameraFormat { return listCameraFormats(id) }

// Backend IDs. Vendor IDs name the graphics hardware that does the work, through whatever the system offers for it
// (NVENC/NVDEC for NVIDIA, VA-API or a Media Foundation vendor transform for AMD and Intel).
const (
	Auto         = ""
	VideoToolbox = "videotoolbox"
	NVIDIA       = "nvidia"
	AMD          = "amd"
	Intel        = "intel"
	Software     = "software"
)

// BackendInfo is one codec choice this system has.
type BackendInfo struct {
	// ID is what EncodeParams.Backend, DecodeParams.Backend and CaptureParams.Backend take.
	ID string
	// Name is for the user: the graphics card or codec, e.g. "NVIDIA GeForce RTX 4070 (NVENC)".
	Name string
}

// Encoders lists the H.264 encoders this system has, the best first; the software one, when there is one, is last. It
// probes the system (it may take a moment on first use); callers cache it.
func Encoders() []BackendInfo { return listEncoders() }

// Decoders lists the H.264 decoders this system has, in the same order.
func Decoders() []BackendInfo { return listDecoders() }
