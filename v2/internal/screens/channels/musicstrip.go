package channels

import (
	"image/color"

	"harmony/v2/internal/music"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	musicStripRadius      = 10
	musicStripFill        = 0.06
	musicStripEdge        = 0.10
	musicStripPadX        = 8.8
	musicStripPadY        = 8
	musicStripSpace       = 5.6
	musicStripCover       = 35.2
	musicStripTextGap     = 0.8
	musicStripBarH        = 3
	musicStripBarRadius   = 2
	musicStripBarFill     = 0.14
	musicStripButton      = 30
	musicStripButtonsPad  = 2.4
	musicStripVolumeH     = 18
	musicStripMuteW       = 24.8
	musicStripMuteH       = 17.4
	musicStripMuteGap     = 4.8
	musicStripFlag        = 15.6
	musicStripFlagGap     = 4
	musicStripPausedAlpha = 0.6
)

// musicTransport is shuffle, previous, play or pause, next, repeat and mix: the same six buttons on the strip and in the panel.
type musicTransport struct {
	shuffle, prev, play, next, repeat, mix widget.PlateButton
}

func (t *musicTransport) init(u *musicUI) {
	t.shuffle = widget.PlateButton{Icon: "shuffle", Variant: widget.Ghost}
	t.prev = widget.PlateButton{Icon: "skip-back", Variant: widget.Ghost, OnClick: func() { u.ask("prev", nil) }}
	t.play = widget.PlateButton{Icon: "pause", Variant: widget.Primary}
	t.next = widget.PlateButton{Icon: "skip-forward", Variant: widget.Ghost, OnClick: func() { u.ask("next", nil) }}
	t.repeat = widget.PlateButton{Icon: "repeat", Variant: widget.Ghost}
	t.mix = widget.PlateButton{Icon: "arrow-clockwise", Variant: widget.Ghost, OnClick: func() { u.ask("reshuffle", nil) }}
	t.shuffle.OnClick = func() { u.ask("shuffle", map[string]any{"on": !u.st.Shuffle}) }
	t.repeat.OnClick = func() { u.ask("repeat", map[string]any{"mode": musicRepeatNext[u.st.Repeat]}) }
	t.play.OnClick = func() {
		if u.st.Status == music.Playing {
			u.ask("pause", nil)
		} else {
			u.ask("resume", nil)
		}
	}
}

// show brings the buttons up to date with the music.
func (t *musicTransport) show(st *music.State) {
	t.play.Icon = "play"
	if st.Status == music.Playing {
		t.play.Icon = "pause"
	}
	t.shuffle.On = st.Shuffle
	t.repeat.On = st.Repeat != "off"
	t.repeat.Icon = "repeat"
	if st.Repeat == "one" {
		t.repeat.Icon = "repeat-once"
	}
}

func (t *musicTransport) buttons() [6]*widget.PlateButton {
	return [6]*widget.PlateButton{&t.shuffle, &t.prev, &t.play, &t.next, &t.repeat, &t.mix}
}

// musicStripHeight is how tall the strip is: the musicTransport is only for those who may steer.
func musicStripHeight(c *widget.Context, may bool) float32 {
	h := 2*(c.Hairline()+musicStripPadY) + musicStripTopH + musicStripSpace + musicStripBarH + musicStripSpace + musicStripVolumeH
	if may {
		h += musicStripButton + musicStripSpace
	}
	return h
}

const musicStripTopH = musicStripTitleLine + musicStripTextGap + musicStripArtistLine

// musicStripExtra is what the strip adds to the voice panel's height.
func musicStripExtra(c *widget.Context, m model) float32 {
	if !m.musicLive {
		return 0
	}
	return musicStripGap + musicStripHeight(c, m.musicCan)
}

func (u *musicUI) stripUnder(c *widget.Context) color.RGBA {
	return theme.Mix(c.Theme.Surface, c.Theme.Tint, musicStripFill)
}

func (u *musicUI) drawStrip(c *widget.Context, s *Screen, box geom.Rect) {
	st, track := u.st, u.st.Now()
	c.Paint.Fill(box, musicStripRadius, theme.WithAlpha(c.Theme.Tint, musicStripFill))
	c.Paint.Stroke(box, musicStripRadius, c.Hairline(), theme.WithAlpha(c.Theme.Tint, musicStripEdge))
	in := box.Inset(c.Hairline()+musicStripPadX, c.Hairline()+musicStripPadY, c.Hairline()+musicStripPadX, c.Hairline()+musicStripPadY)

	cover := widget.Cover{Hash: track.ThumbHash, Source: s.Session.Chat(), Size: musicStripCover, Under: u.stripUnder(c)}
	cover.Draw(c, geom.Rect{X: in.X, Y: in.Y + (musicStripTopH-musicStripCover)/2})
	textX := in.X + musicStripCover + musicStripPadY
	textW := in.Right() - textX
	if !u.may {
		textW -= u.flagsWidth(st) + musicStripPadY
		u.drawFlags(c, st, geom.Rect{X: in.Right(), Y: in.Y, H: musicStripTopH})
	}
	u.title.Content = track.Title
	if u.title.Content == "" {
		u.title.Content = c.T("music.untitled")
	}
	u.title.Opacity = 0
	if st.Status == music.Paused {
		u.title.Opacity = musicStripPausedAlpha
	}
	u.by.Content = track.Artist
	if st.Status == music.Loading {
		u.by.Content = c.T("music.loading")
	}
	u.title.Draw(c, geom.Rect{X: textX, Y: in.Y, W: textW, H: musicStripTitleLine})
	u.by.Draw(c, geom.Rect{X: textX, Y: in.Y + musicStripTitleLine + musicStripTextGap, W: textW, H: musicStripArtistLine})
	u.opener = geom.Rect{X: textX, Y: in.Y, W: textW, H: musicStripTopH}
	if c.Hovered(u.opener) && c.Clicked(u.opener) {
		c.Claim()
		u.toggle()
	}

	y := in.Y + musicStripTopH + musicStripSpace
	barTrack := geom.Rect{X: in.X, Y: y, W: in.W, H: musicStripBarH}
	c.Paint.Fill(barTrack, musicStripBarRadius, theme.WithAlpha(c.Theme.Tint, musicStripBarFill))
	if ratio := u.progress(track); ratio > 0 {
		c.Paint.Fill(geom.Rect{X: barTrack.X, Y: y, W: barTrack.W * ratio, H: musicStripBarH}, musicStripBarRadius, c.Theme.Accent)
	}
	y += musicStripBarH + musicStripSpace

	if u.may {
		u.strip.show(st)
		buttons := u.strip.buttons()
		left, span := in.X+musicStripButtonsPad, in.W-2*musicStripButtonsPad
		gap := (span - float32(len(buttons))*musicStripButton) / float32(len(buttons)-1)
		for i, b := range buttons {
			b.Draw(c, geom.Rect{X: left + float32(i)*(musicStripButton+gap), Y: y, W: musicStripButton, H: musicStripButton})
		}
		y += musicStripButton + musicStripSpace
	}
	u.mute.Draw(c, geom.Rect{X: in.X, Y: y + (musicStripVolumeH-musicStripMuteH)/2, W: musicStripMuteW, H: musicStripMuteH})
	volumeX := in.X + musicStripMuteW + musicStripMuteGap
	u.vol.Draw(c, geom.Rect{X: volumeX, Y: y, W: in.Right() - volumeX, H: musicStripVolumeH})
}

// progress is how far into the track the music is, from 0 to 1.
func (u *musicUI) progress(track *music.Track) float32 {
	if track.DurationMs <= 0 {
		return 0
	}
	at := min(u.sess.MusicPosition().Milliseconds(), track.DurationMs)
	return float32(at) / float32(track.DurationMs)
}

func (u *musicUI) flags(st *music.State) (shuffle, repeat bool) {
	return st.Shuffle, st.Repeat != "off"
}

func (u *musicUI) flagsWidth(st *music.State) float32 {
	shuffle, repeat := u.flags(st)
	w := float32(0)
	if shuffle {
		w += musicStripFlag
	}
	if repeat {
		w += musicStripFlag
	}
	if shuffle && repeat {
		w += musicStripFlagGap
	}
	return w
}

// drawFlags shows what listeners cannot press, ending at the right edge of r.
func (u *musicUI) drawFlags(c *widget.Context, st *music.State, r geom.Rect) {
	shuffle, repeat := u.flags(st)
	x := r.X - u.flagsWidth(st)
	y := r.Y + (r.H-musicStripFlag)/2
	if shuffle {
		c.Paint.Icon("shuffle", geom.Rect{X: x, Y: y, W: musicStripFlag, H: musicStripFlag}, c.Theme.Accent)
		x += musicStripFlag + musicStripFlagGap
	}
	if repeat {
		icon := "repeat"
		if st.Repeat == "one" {
			icon = "repeat-once"
		}
		c.Paint.Icon(icon, geom.Rect{X: x, Y: y, W: musicStripFlag, H: musicStripFlag}, c.Theme.Accent)
	}
}
