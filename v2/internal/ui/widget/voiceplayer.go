package widget

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	voiceMaxW      = 340
	voicePadL      = 8
	voicePadR      = 11.2
	voicePadY      = 7.2
	voiceGap       = 9.6
	voicePlay      = 35.2
	voicePlayIcon  = 17.6
	voiceTimeW     = 38.4
	voiceTimeSize  = 12.48
	voiceTimeLine  = 18.7
	voiceSpeedPadX = 6.4
	voiceSpeedH    = 20.5
	voiceSpeedSize = 11.52
	voiceFill      = 0.09
	voiceSpeedFill = 0.14
)

var (
	voiceTimeStyle  = paint.TextStyle{Size: voiceTimeSize, Weight: paint.Regular}
	voiceSpeedStyle = paint.TextStyle{Size: voiceSpeedSize, Weight: paint.Medium}
)

// VoicePlayer is a voice message in the chat: play, the waveform, the time and the playback speed.
type VoicePlayer struct {
	Peaks    []byte
	Bars     int
	Progress float32
	Playing  bool
	Time     string
	Speed    string
	OnPlay   func()
	OnSeek   func(fraction float32)
	OnSpeed  func()
}

func (v *VoicePlayer) Measure(_ *Context, maxWidth float32) geom.Size {
	return geom.Size{W: min(voiceMaxW, maxWidth), H: voicePlay + 2*voicePadY}
}

func (v *VoicePlayer) Draw(c *Context, r geom.Rect) {
	c.Paint.Fill(r, r.H/2, theme.WithAlpha(c.Theme.Tint, voiceFill))
	play := geom.Rect{X: r.X + voicePadL, Y: r.Y + voicePadY, W: voicePlay, H: voicePlay}
	v.drawPlay(c, play)

	speedW := c.Paint.TextWidth(v.Speed, voiceSpeedStyle) + 2*voiceSpeedPadX
	speed := geom.Rect{X: r.Right() - voicePadR - speedW, Y: r.Y + (r.H-voiceSpeedH)/2, W: speedW, H: voiceSpeedH}
	length := geom.Rect{X: speed.X - voiceGap - voiceTimeW, Y: r.Y + (r.H-voiceTimeLine)/2, W: voiceTimeW, H: voiceTimeLine}
	wave := geom.Rect{X: play.Right() + voiceGap, Y: r.Y + voicePadY + (voicePlay-32)/2, W: max(0, length.X-voiceGap-play.Right()-voiceGap), H: 32}
	(&Waveform{Peaks: v.Peaks, Bars: v.Bars, Progress: v.Progress, OnSeek: v.OnSeek}).Draw(c, wave)
	c.Paint.Text(v.Time, length.X, length.Y, voiceTimeLine, voiceTimeStyle, c.Theme.Muted)

	c.Paint.Fill(speed, speed.H/2, theme.WithAlpha(c.Theme.Tint, voiceSpeedFill))
	c.Paint.Text(v.Speed, speed.X+voiceSpeedPadX, speed.Y+(speed.H-voiceTimeLine)/2, voiceTimeLine, voiceSpeedStyle, c.Theme.Text)
	if c.Hovered(speed) {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(speed) {
			c.Claim()
			v.OnSpeed()
		}
	}
}

func (v *VoicePlayer) drawPlay(c *Context, r geom.Rect) {
	if c.Hovered(r) {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(r) {
			c.Claim()
			v.OnPlay()
		}
	}
	c.Paint.Circle(r.X+r.W/2, r.Y+r.H/2, r.W/2, c.Theme.Accent)
	icon := "play"
	if v.Playing {
		icon = "pause"
	}
	c.Paint.Icon(icon, geom.Rect{X: r.X + (r.W-voicePlayIcon)/2, Y: r.Y + (r.H-voicePlayIcon)/2, W: voicePlayIcon, H: voicePlayIcon}, rl.White)
}
