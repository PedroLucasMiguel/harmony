package settings

import (
	"strconv"

	"harmony/v2/internal/app"
	"harmony/v2/internal/ui/widget"
)

const (
	sensitivityMax = 100
	micRowGap      = 9.6
)

// micTuning is the part of the Voice & video page that shapes the microphone: volume, the noise gate and its meter, and what is taken out of the sound.
type micTuning struct {
	d           *Dialog
	sensitivity widget.Slider
	auto        widget.Switch
	echo        widget.Switch
	noise       widget.Switch
	agc         widget.Switch
	ai          widget.Switch
	ptt         widget.Switch
	meter       widget.MicMeter
}

func newMicTuning(d *Dialog, gain *widget.Slider) *micTuning {
	m := &micTuning{d: d}
	s := d.Settings
	apply := func() {
		d.Session.ApplyAudioSettings(s)
		d.invalidate()
	}
	gain.OnChange = func(percent int) {
		s.MicGain = percent
		apply()
	}
	gain.OnCommit = func(int) { s.Save() }

	m.sensitivity = widget.Slider{Min: 0, Max: sensitivityMax, Step: 1, Value: s.MicSensitivity}
	m.sensitivity.OnChange = func(value int) {
		s.MicSensitivity = value
		apply()
	}
	m.sensitivity.OnCommit = func(int) { s.Save() }

	toggle := func(sw *widget.Switch, on bool, set func(bool)) {
		sw.On = on
		sw.OnChange = func(v bool) {
			set(v)
			s.Save()
			apply()
		}
	}
	toggle(&m.auto, s.MicAutoSensitivity, func(v bool) { s.MicAutoSensitivity = v })
	m.echo.On = s.MicEchoCancellation
	m.echo.OnChange = func(v bool) {
		s.MicEchoCancellation = v
		s.Save()
		go func() {
			_ = d.Devices.SetEchoCancellation(v)
			d.ctx.Post(d.invalidate)
		}()
	}
	toggle(&m.noise, s.MicNoiseSuppression, func(v bool) { s.MicNoiseSuppression = v })
	toggle(&m.agc, s.MicAutoGain, func(v bool) { s.MicAutoGain = v })
	toggle(&m.ai, s.MicAISuppression, func(v bool) { s.MicAISuppression = v })
	toggle(&m.ptt, s.PushToTalk, func(v bool) {
		s.PushToTalk = v
		d.Session.SetPushToTalk(v)
		if d.Desktop != nil {
			d.Desktop.SyncHotkeys()
		}
	})

	m.meter = widget.MicMeter{
		Level: d.Session.MicLevel,
		Mark:  m.mark,
		Gated: func() bool { return !d.Session.Mic().Open() },
	}
	return m
}

// mark is where the gate sits on the meter: the set threshold, or what the automatic sensitivity has found once it has heard the room.
func (m *micTuning) mark() float64 {
	s := m.d.Settings
	switch {
	case s.MicAutoSensitivity:
		return m.d.Session.Mic().Threshold()
	default:
		return app.GateThreshold(s.MicSensitivity)
	}
}

func (m *micTuning) sensitivityLabel(c *widget.Context) string {
	s := m.d.Settings
	switch {
	case s.MicAutoSensitivity:
		return c.T("settings.voice.auto_label")
	case s.MicSensitivity == 0:
		return c.T("app.off")
	}
	return strconv.Itoa(s.MicSensitivity)
}

// volumeCard is the input volume and the sensitivity, the automatic switch, the meter and its hint.
func (m *micTuning) volumeCard(c *widget.Context, gain *widget.Slider) widget.Component {
	s := m.d.Settings
	m.sensitivity.Value = s.MicSensitivity
	m.sensitivity.Disabled = s.MicAutoSensitivity
	m.auto.On = s.MicAutoSensitivity
	return &widget.SettingCard{
		Title: c.T("settings.voice.input_volume"),
		Tools: widget.ValuePill{Content: strconv.Itoa(s.MicGain) + "%"},
		Children: []widget.Component{
			widget.Padded{Bottom: widget.RangeAfter, Child: widget.RangeRow{Slider: gain}},
			widget.SettingHead{Title: c.T("settings.voice.input_sensitivity"), Tools: widget.ValuePill{Content: m.sensitivityLabel(c)}},
			widget.Padded{Bottom: widget.RangeAfter + micRowGap, Child: widget.RangeRow{Slider: &m.sensitivity}},
			widget.ToggleRow{Title: c.T("settings.voice.auto_sensitivity"), Hint: c.T("settings.voice.auto_sensitivity_hint"), Switch: &m.auto},
			widget.Padded{Top: micRowGap, Child: &m.meter},
			widget.SettingNote{Content: c.T("settings.voice.speak_normally_put_the")},
		},
	}
}

// processingCard is what is taken out of the sound before it is sent.
func (m *micTuning) processingCard(c *widget.Context) widget.Component {
	s := m.d.Settings
	m.echo.On, m.noise.On, m.agc.On, m.ai.On = s.MicEchoCancellation, s.MicNoiseSuppression, s.MicAutoGain, s.MicAISuppression
	echoNote := m.d.Devices.EchoNote()
	return &widget.SettingCard{Children: []widget.Component{
		widget.ToggleList{
			{Title: c.T("settings.voice.echo_cancellation"), Hint: c.T("settings.voice.echo_cancellation_hint"), Switch: &m.echo, Status: echoNote, StatusError: echoNote != ""},
			{Title: c.T("settings.voice.noise_suppression"), Hint: c.T("settings.voice.noise_suppression_hint"), Switch: &m.noise, Dim: s.MicAISuppression},
			{Title: c.T("settings.voice.auto_gain"), Hint: c.T("settings.voice.auto_gain_hint"), Switch: &m.agc},
			{Title: c.T("settings.voice.ai_suppression"), Hint: c.T("settings.voice.ai_suppression_hint"), Switch: &m.ai, Status: m.aiStatus(c)},
		},
	}}
}

func (m *micTuning) aiStatus(c *widget.Context) string {
	if m.d.Settings.MicAISuppression {
		return c.T("settings.voice.ai_status_ready")
	}
	return ""
}

func (m *micTuning) pushToTalkCard(c *widget.Context) widget.Component {
	m.ptt.On = m.d.Settings.PushToTalk
	return &widget.SettingCard{Children: []widget.Component{
		widget.ToggleRow{Title: c.T("settings.voice.push_to_talk"), Hint: c.T("settings.voice.push_to_talk_hint"), Switch: &m.ptt},
	}}
}
