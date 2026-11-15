package audio

import "errors"

var errEchoUnsupported = errors.New("this system has no echo cancellation")

var errNoAudio = errors.New("no sound card support in this build")

// Device is a sound card input or output; ID is empty for the system's own choice.
type Device struct {
	ID   string
	Name string
}
