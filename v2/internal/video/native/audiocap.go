package native

// What the computer is playing, captured to send with a screen share: ScreenCaptureKit on macOS, WASAPI loopback on Windows,
// the default output's monitor through PulseAudio (or PipeWire's pulse server) on Linux. One file per platform:
// audiocap_<os>.go.

// AudioCaptureParams say whose sound is captured.
type AudioCaptureParams struct {
	// PID is an application whose audio alone is captured (its whole process tree where the system knows it); 0 captures
	// everything the system plays.
	PID int
	// ExcludePID leaves one application out of everything the system plays (a voice chat, usually this program); 0
	// excludes nobody. Ignored when PID is set. macOS always leaves this program's own sound out.
	ExcludePID int
}

// AudioCapture is a running audio capture.
type AudioCapture interface {
	Close()
}

// AudioApp is an application that can be kept out of a share's sound or be its only sound.
type AudioApp struct {
	PID  int
	Name string
	// Self is this program.
	Self bool
}

// AudioSupport says what this system can do about the sound of a share.
type AudioSupport struct {
	// System is whether everything the computer plays can be captured at all.
	System bool
	// Exclude is whether one application can be left out of it.
	Exclude bool
	// App is whether one application's sound can be captured alone.
	App bool
	// ExcludesSelf is whether this program's own sound is always left out of what is captured.
	ExcludesSelf bool
	// Reason says what is missing when System is false.
	Reason string
}

// StartAudioCapture starts capturing and calls onPCM, from the capture's own goroutine, with blocks of 48 kHz stereo
// interleaved samples that are valid only during the call. It returns an error at once when the sound cannot be captured
// or the user has not allowed it; the error names the permission.
func StartAudioCapture(p AudioCaptureParams, onPCM func(pcm []int16)) (AudioCapture, error) {
	return startAudioCapture(p, onPCM)
}

// AudioApps lists the applications that can be left out or captured alone, this program included.
func AudioApps() []AudioApp { return listAudioApps() }

// AudioSupportOf is what this system can do; it probes, so callers cache it.
func AudioSupportOf() AudioSupport { return audioSupport() }

// WindowAudioPID is the application that owns the window of a "window:<n>" source ID (native.Sources), 0 when the system
// cannot say; its sound is what a window share carries.
func WindowAudioPID(sourceID string) int {
	if n, ok := parseSourceNumber(sourceID, KindWindow); ok {
		return windowAudioPID(n)
	}
	return 0
}
