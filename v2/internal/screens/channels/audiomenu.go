package channels

import (
	"harmony/v2/internal/audio"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/widget"
)

const volumeMax = 200

type audioKind int

const (
	audioNone audioKind = iota
	audioInput
	audioOutput
)

// audioControls is the device and volume menu behind the microphone and headphone buttons, one menu for both.
type audioControls struct {
	menu    widget.AudioMenu
	kind    audioKind
	anchor  geom.Rect
	trigger geom.Rect
	inputs  []widget.Option
	outputs []widget.Option
	wired   bool
}

func (s *Screen) wireAudioMenu() {
	if s.audio.wired {
		return
	}
	s.audio.wired = true
	m := &s.audio.menu
	m.Volume.Max = volumeMax
	m.OnPick = s.pickDevice
	m.OnSettings = func() {
		if s.OnSettings != nil {
			s.OnSettings()
		}
	}
	m.Volume.OnChange = s.setVolume
	m.Volume.OnSettle = func(int) { s.Settings.Save() }
}

// toggleAudioMenu opens the menu for that button, or closes it when it is already showing that one.
func (s *Screen) toggleAudioMenu(c *widget.Context, kind audioKind) {
	if s.audio.menu.IsOpen() && s.audio.kind == kind {
		s.audio.menu.Close()
		return
	}
	s.openAudioMenu(c, kind)
}

func (s *Screen) openAudioMenu(c *widget.Context, kind audioKind) {
	s.wireAudioMenu()
	s.audio.kind = kind
	if kind == audioInput {
		s.audio.inputs = deviceOptions(c, s.Devices.Inputs())
	} else {
		s.audio.outputs = deviceOptions(c, s.Devices.Outputs())
	}
	s.audio.menu.Open()
}

func deviceOptions(c *widget.Context, devices []audio.Device) []widget.Option {
	options := make([]widget.Option, 0, len(devices)+1)
	options = append(options, widget.Option{Label: c.T("audio_menu.system_default")})
	for _, d := range devices {
		options = append(options, widget.Option{Value: d.ID, Label: d.Name})
	}
	return options
}

// showAudioMenu fills the menu for the button it was opened from and draws it.
func (s *Screen) showAudioMenu(c *widget.Context) {
	m := &s.audio.menu
	if !m.IsOpen() {
		return
	}
	if s.audio.kind == audioInput {
		m.Icon, m.Devices, m.Selected = "microphone", s.audio.inputs, known(s.audio.inputs, s.Settings.InputDevice)
		m.DeviceTitle, m.VolumeTitle = c.T("audio_menu.input_device"), c.T("audio_menu.input_volume")
		m.Volume.Value = s.Settings.MicGain
	} else {
		m.Icon, m.Devices, m.Selected = "speaker-high", s.audio.outputs, known(s.audio.outputs, s.Settings.OutputDevice)
		m.DeviceTitle, m.VolumeTitle = c.T("audio_menu.output_device"), c.T("audio_menu.output_volume")
		m.Volume.Value = s.Settings.MasterVolume
	}
	m.SettingsLabel = c.T("audio_menu.voice_settings")
	m.Show(c, s.audio.anchor, s.audio.trigger)
}

// known is the id when the list has it, else the system's own.
func known(options []widget.Option, id string) string {
	for _, o := range options {
		if o.Value == id {
			return id
		}
	}
	return ""
}

func (s *Screen) pickDevice(id string) {
	input := s.audio.kind == audioInput
	if input {
		s.Settings.InputDevice = id
	} else {
		s.Settings.OutputDevice = id
	}
	s.Settings.Save()
	go func() {
		if input {
			_ = s.Devices.SetInput(id)
		} else {
			_ = s.Devices.SetOutput(id)
		}
	}()
}

func (s *Screen) setVolume(percent int) {
	if s.audio.kind == audioInput {
		s.Settings.MicGain = percent
		s.Session.SetMicGain(float64(percent) / 100)
	} else {
		s.Settings.MasterVolume = percent
		s.Session.SetOutputVolume(float64(percent) / 100)
	}
}
