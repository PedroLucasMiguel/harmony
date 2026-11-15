package channels

import (
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/widget"
)

// drawSoundboard hangs the soundboard popover from its button on the voice panel.
func (s *Screen) drawSoundboard(c *widget.Context, button geom.Rect) {
	if s.sound.Session == nil {
		s.sound.Session, s.sound.Settings, s.sound.OnError, s.sound.Keys = s.Session, s.Settings, s.fail, s.ClipKeys
	}
	s.Session.SetClipVolume(s.Settings.SoundpadVolume)
	s.sound.Show(c, button)
}
