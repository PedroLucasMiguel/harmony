//go:build !darwin && !windows && !linux

package native

func newDecoder(DecodeParams, func([]byte, int, int)) (Decoder, error) { return nil, ErrUnsupported }

func newEncoder(EncodeParams, func([]byte)) (Encoder, error) { return nil, ErrUnsupported }

func startCapture(CaptureParams, func([]byte), func(error)) (Capture, error) {
	return nil, ErrUnsupported
}

func listCameras() []CameraInfo { return nil }

func listEncoders() []BackendInfo { return nil }

func listDecoders() []BackendInfo { return nil }

func listCameraFormats(string) []CameraFormat { return nil }

func listSources() []SourceInfo { return nil }

func sourceThumbnail(string, int) ([]byte, int, int, bool) { return nil, 0, 0, false }

func screenAccess() bool { return true }

func openScreenSettings() {}
