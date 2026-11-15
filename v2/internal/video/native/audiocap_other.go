//go:build !darwin && !windows && !linux

package native

func startAudioCapture(AudioCaptureParams, func([]int16)) (AudioCapture, error) {
	return nil, ErrUnsupported
}

func listAudioApps() []AudioApp { return nil }

func audioSupport() AudioSupport { return AudioSupport{Reason: ErrUnsupported.Error()} }

func windowAudioPID(uint32) int { return 0 }
