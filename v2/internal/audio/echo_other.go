//go:build cgo && !darwin && !windows && !linux

package audio

type echoState struct{ note, source, sink string }

func (d *Devices) echoOwnsIO() bool { return false }

func (d *Devices) echoStart() error { return errEchoUnsupported }

func (d *Devices) echoStop() {}

func (d *Devices) echoRetarget() {}

func (d *Devices) echoReference([]int16) {}

func (d *Devices) echoClean([]int16) {}

func (d *Devices) reopenVoice() error { return nil }

func (d *Devices) dropVoice() {}

func (d *Devices) closeVoice() {}

func echoDevice(string) bool { return false }
