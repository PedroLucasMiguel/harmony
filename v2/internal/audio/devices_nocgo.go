//go:build !cgo

package audio

type Devices struct{}

func OpenDevices() (*Devices, error) { return nil, errNoAudio }

func (d *Devices) Inputs() []Device { return nil }

func (d *Devices) Outputs() []Device { return nil }

func (d *Devices) SetInput(string) error { return errNoAudio }

func (d *Devices) SetOutput(string) error { return errNoAudio }

func (d *Devices) StartSpeakers(*Mixer) error { return errNoAudio }

func (d *Devices) StopSpeakers() {}

func (d *Devices) StartMicrophone(func([]int16)) error { return errNoAudio }

func (d *Devices) StopMicrophone() {}

func (d *Devices) Close() {}

func (d *Devices) SetEchoCancellation(bool) error { return errNoAudio }

func (d *Devices) EchoNote() string { return "" }
