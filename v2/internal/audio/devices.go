//go:build cgo

package audio

import (
	"errors"
	"sync"
	"unsafe"

	"github.com/gen2brain/malgo"
)

type Devices struct {
	ctx *malgo.AllocatedContext

	mu       sync.Mutex
	capture  *malgo.Device
	play     *malgo.Device
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
	ctx, err := malgo.InitContext(nil, malgo.ContextConfig{}, func(string) {})
	if err != nil {
		return nil, err
	}
	return &Devices{ctx: ctx}, nil
}

func asInt16(b []byte) []int16 {
	if len(b) < 2 {
		return nil
	}
	return unsafe.Slice((*int16)(unsafe.Pointer(&b[0])), len(b)/2)
}

func (d *Devices) Inputs() []Device { return d.list(malgo.Capture) }

func (d *Devices) Outputs() []Device { return d.list(malgo.Playback) }

func (d *Devices) list(kind malgo.DeviceType) []Device {
	if d == nil {
		return nil
	}
	infos, err := d.ctx.Devices(kind)
	if err != nil {
		return nil
	}
	list := make([]Device, len(infos))
	list = list[:0]
	for i := range infos {
		if id := infos[i].ID.String(); !echoDevice(id) {
			list = append(list, Device{ID: id, Name: infos[i].Name()})
		}
	}
	return list
}

// find is the native id of the device with that id, or nil for the system's own choice and for one that is gone.
func (d *Devices) find(kind malgo.DeviceType, id string) unsafe.Pointer {
	if id == "" {
		return nil
	}
	infos, err := d.ctx.Devices(kind)
	if err != nil {
		return nil
	}
	for i := range infos {
		if infos[i].ID.String() == id {
			native := infos[i].ID
			return unsafe.Pointer(&native)
		}
	}
	return nil
}

// SetInput picks the microphone; one already open moves to it at once.
func (d *Devices) SetInput(id string) error {
	if d == nil {
		return errNoAudio
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.inputID = id
	if d.echoOwnsIO() {
		return d.reopenVoice()
	}
	d.echoRetarget()
	if d.capture == nil {
		return nil
	}
	d.capture.Uninit()
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
	if d.echoOwnsIO() {
		return d.reopenVoice()
	}
	d.echoRetarget()
	if d.play == nil {
		return nil
	}
	d.play.Uninit()
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
		d.play.Uninit()
		d.play = nil
	}
}

// openSpeakers falls back to the system's own device when the chosen one will not open.
func (d *Devices) openSpeakers() error {
	if d.echoOwnsIO() {
		return d.reopenVoice()
	}
	dev, err := d.initSpeakers(d.find(malgo.Playback, d.playbackID()))
	if err != nil && d.playbackID() != "" {
		if dev, fallback := d.initSpeakers(nil); fallback == nil {
			d.play = dev
		}
		return err
	}
	d.play = dev
	return err
}

func (d *Devices) initSpeakers(id unsafe.Pointer) (*malgo.Device, error) {
	cfg := malgo.DefaultDeviceConfig(malgo.Playback)
	cfg.Playback.Format = malgo.FormatS16
	cfg.Playback.Channels = 2
	cfg.Playback.DeviceID = id
	cfg.SampleRate = sampleRate
	cfg.PeriodSizeInMilliseconds = 10
	mixer := d.mixer
	dev, err := malgo.InitDevice(d.ctx.Context, cfg, malgo.DeviceCallbacks{
		Data: func(out, _ []byte, _ uint32) {
			if pcm := asInt16(out); pcm != nil {
				mixer.Mix(pcm)
				d.echoReference(pcm)
			}
		},
	})
	if err != nil {
		return nil, err
	}
	if err := dev.Start(); err != nil {
		dev.Uninit()
		return nil, err
	}
	return dev, nil
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
	if d.echoOwnsIO() {
		return d.reopenVoice()
	}
	dev, err := d.initMicrophone(d.find(malgo.Capture, d.captureID()))
	if err != nil && d.captureID() != "" {
		if dev, fallback := d.initMicrophone(nil); fallback == nil {
			d.capture = dev
		}
		return err
	}
	d.capture = dev
	return err
}

func (d *Devices) initMicrophone(id unsafe.Pointer) (*malgo.Device, error) {
	cfg := malgo.DefaultDeviceConfig(malgo.Capture)
	cfg.Capture.Format = malgo.FormatS16
	cfg.Capture.Channels = 1
	cfg.Capture.DeviceID = id
	cfg.SampleRate = sampleRate
	cfg.PeriodSizeInMilliseconds = 10

	const frame = sampleRate / 50
	pending := make([]int16, 0, frame*2)
	onFrame := d.onFrame
	dev, err := malgo.InitDevice(d.ctx.Context, cfg, malgo.DeviceCallbacks{
		Data: func(_, in []byte, _ uint32) {
			pending = append(pending, asInt16(in)...)
			for len(pending) >= frame {
				d.echoClean(pending[:frame])
				onFrame(pending[:frame])
				pending = append(pending[:0], pending[frame:]...)
			}
		},
	})
	if err != nil {
		return nil, err
	}
	if err := dev.Start(); err != nil {
		dev.Uninit()
		return nil, err
	}
	return dev, nil
}

func (d *Devices) StopMicrophone() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.micWanted = false
	d.dropVoice()
	if d.capture != nil {
		d.capture.Uninit()
		d.capture = nil
	}
}

func (d *Devices) Close() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.echoOn, d.speakersWanted, d.micWanted = false, false, false
	d.dropVoice()
	d.echoStop()
	if d.capture != nil {
		d.capture.Uninit()
		d.capture = nil
	}
	if d.play != nil {
		d.play.Uninit()
		d.play = nil
	}
	if d.ctx != nil {
		_ = d.ctx.Uninit()
		d.ctx.Free()
		d.ctx = nil
	}
}

// closeAll shuts every open stream, the voice unit included.
func (d *Devices) closeAll() {
	if d.capture != nil {
		d.capture.Uninit()
		d.capture = nil
	}
	if d.play != nil {
		d.play.Uninit()
		d.play = nil
	}
	d.closeVoice()
}
