//go:build windows

package audio

import (
	"errors"
	"sync"
)

// Devices is the sound card: the speakers play what the mixer makes, the microphone hands over 20 ms frames of mono sound.
type Devices struct {
	mu       sync.Mutex
	capture  *stream
	play     *stream
	inputID  string
	outputID string
	mixer    *Mixer
	onFrame  func(frame []int16)

	echo           echoState
	echoOn         bool
	speakersWanted bool
	micWanted      bool
}

func OpenDevices() (*Devices, error) {
	var err error
	onCOMThread(func() {
		var enum com
		if enum, err = newEnumerator(); err == nil {
			enum.release()
		}
	})
	if err != nil {
		return nil, err
	}
	return &Devices{}, nil
}

func (d *Devices) Inputs() []Device { return listEndpoints(eCapture) }

func (d *Devices) Outputs() []Device { return listEndpoints(eRender) }

// SetInput picks the microphone; one already open moves to it at once.
func (d *Devices) SetInput(id string) error {
	if d == nil {
		return errNoAudio
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.inputID = id
	d.echoRetarget()
	if d.capture == nil {
		return nil
	}
	d.capture.Close()
	d.capture = nil
	return d.openMicrophone()
}

// SetOutput picks the speakers; ones already open move to it at once.
func (d *Devices) SetOutput(id string) error {
	if d == nil {
		return errNoAudio
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.outputID = id
	d.echoRetarget()
	if d.play == nil {
		return nil
	}
	d.play.Close()
	d.play = nil
	return d.openSpeakers()
}

func (d *Devices) StartSpeakers(mixer *Mixer) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.play != nil {
		return nil
	}
	d.mixer = mixer
	d.speakersWanted = true
	return d.openSpeakers()
}

// StopSpeakers closes the sound output; StartSpeakers opens it again.
func (d *Devices) StopSpeakers() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.speakersWanted = false
	d.dropVoice()
	if d.play != nil {
		d.play.Close()
		d.play = nil
	}
}

// openSpeakers falls back to the system's own device when the chosen one will not open.
func (d *Devices) openSpeakers() error {
	dev, err := d.initSpeakers(d.playbackID())
	if err != nil && d.playbackID() != "" {
		if dev, fallback := d.initSpeakers(""); fallback == nil {
			d.play = dev
		}
		return err
	}
	d.play = dev
	return err
}

func (d *Devices) initSpeakers(id string) (*stream, error) {
	mixer := d.mixer
	return openStream(true, id, 2, func(pcm []int16) {
		mixer.Mix(pcm)
		d.echoReference(pcm)
	}, nil)
}

func (d *Devices) StartMicrophone(onFrame func(frame []int16)) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.capture != nil {
		return errors.New("the microphone is already open")
	}
	d.onFrame = onFrame
	d.micWanted = true
	return d.openMicrophone()
}

func (d *Devices) openMicrophone() error {
	dev, err := d.initMicrophone(d.captureID())
	if err != nil && d.captureID() != "" {
		if dev, fallback := d.initMicrophone(""); fallback == nil {
			d.capture = dev
		}
		return err
	}
	d.capture = dev
	return err
}

func (d *Devices) initMicrophone(id string) (*stream, error) {
	const frame = sampleRate / 50
	pending := make([]int16, 0, frame*2)
	onFrame := d.onFrame
	return openStream(false, id, 1, nil, func(in []int16) {
		pending = append(pending, in...)
		for len(pending) >= frame {
			d.echoClean(pending[:frame])
			onFrame(pending[:frame])
			pending = append(pending[:0], pending[frame:]...)
		}
	})
}

func (d *Devices) StopMicrophone() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.micWanted = false
	d.dropVoice()
	if d.capture != nil {
		d.capture.Close()
		d.capture = nil
	}
}

func (d *Devices) Close() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.echoOn, d.speakersWanted, d.micWanted = false, false, false
	d.dropVoice()
	d.echoStop()
	d.closeAll()
}

// closeAll shuts every open stream.
func (d *Devices) closeAll() {
	if d.capture != nil {
		d.capture.Close()
		d.capture = nil
	}
	if d.play != nil {
		d.play.Close()
		d.play = nil
	}
	d.closeVoice()
}
