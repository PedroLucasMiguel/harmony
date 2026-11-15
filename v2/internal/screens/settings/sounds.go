package settings

import (
	"strconv"

	"harmony/v2/internal/audio"
	"harmony/v2/internal/ui/widget"
)

type sounds struct {
	d                      *Dialog
	master, effects        widget.Slider
	voice, custom, mention widget.Switch
}

func newSounds(d *Dialog) *sounds {
	s := &sounds{d: d}
	set := d.Settings
	s.master = widget.Slider{Min: 0, Max: volumeMax, Step: 1, Value: set.MasterVolume}
	s.master.OnChange = func(percent int) {
		set.MasterVolume = percent
		d.Session.SetOutputVolume(float64(percent) / 100)
		d.invalidate()
	}
	s.master.OnCommit = func(int) {
		set.Save()
		d.Session.PreviewCue(audio.CueJoin)
	}

	s.effects = widget.Slider{Min: 0, Max: volumeMax, Step: 1, Value: set.SoundVolume}
	s.effects.OnChange = func(percent int) {
		set.SoundVolume = percent
		d.Session.ApplyAudioSettings(set)
		d.invalidate()
	}
	s.effects.OnCommit = func(int) {
		set.Save()
		d.Session.PreviewCue(audio.CueJoin)
	}

	toggle := func(sw *widget.Switch, on bool, set func(bool), heard audio.Cue, preview bool) {
		sw.On = on
		sw.OnChange = func(v bool) {
			set(v)
			d.Settings.Save()
			d.Session.ApplyAudioSettings(d.Settings)
			if v && preview {
				d.Session.PreviewCue(heard)
			}
			d.invalidate()
		}
	}
	toggle(&s.voice, set.VoiceSounds, func(v bool) { set.VoiceSounds = v }, audio.CueJoin, true)
	toggle(&s.custom, set.CustomJoinSounds, func(v bool) { set.CustomJoinSounds = v }, audio.CueJoin, false)
	toggle(&s.mention, set.MentionSound, func(v bool) { set.MentionSound = v }, audio.CueMention, true)
	return s
}

func (s *sounds) icon() string                   { return "speaker-high" }
func (s *sounds) label(c *widget.Context) string { return c.T("settings.sounds") }

func (s *sounds) build(c *widget.Context) widget.Component {
	set := s.d.Settings
	s.master.Value, s.effects.Value = set.MasterVolume, set.SoundVolume
	s.voice.On, s.custom.On, s.mention.On = set.VoiceSounds, set.CustomJoinSounds, set.MentionSound
	return widget.Col(0,
		widget.PageTitle(c.T("settings.sounds.sounds")),
		&widget.SettingCard{
			Title: c.T("settings.sounds.master_volume"),
			Tools: widget.ValuePill{Content: strconv.Itoa(set.MasterVolume) + "%"},
			Children: []widget.Component{
				widget.Padded{Bottom: widget.RangeAfter, Child: widget.RangeRow{Slider: &s.master}},
				widget.SettingNote{Content: c.T("settings.sounds.master_volume_hint")},
			},
		},
		&widget.SettingCard{Children: []widget.Component{
			widget.ToggleList{
				{Title: c.T("settings.sounds.voice_channel_sounds"), Hint: c.T("settings.sounds.when_you_or_somebody"), Switch: &s.voice},
				{Title: c.T("settings.sounds.members_join_sounds"), Hint: c.T("settings.sounds.members_join_sounds_hint"), Switch: &s.custom},
				{Title: c.T("settings.sounds.mention_sound"), Hint: c.T("settings.sounds.three_rising_notes_when"), Switch: &s.mention},
			},
		}},
		&widget.SettingCard{
			Title: c.T("settings.sounds.sound_effects_volume"),
			Tools: widget.ValuePill{Content: strconv.Itoa(set.SoundVolume) + "%"},
			Children: []widget.Component{
				widget.RangeRow{Slider: &s.effects},
			},
		},
	)
}
