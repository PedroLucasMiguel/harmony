package widget

import (
	"image/color"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
)

const (
	audioW         = 300
	audioH         = 54
	audioPlayX     = 27
	audioPlayIcon  = 14.4
	audioTimeX     = 47
	audioTimeSize  = 13
	audioTimeLine  = 21
	audioSeekX     = 129.4
	audioSeekW     = 80.8
	audioSeekH     = 3.6
	audioSpeakerX  = 234
	audioSpeakerSz = 16
	audioMoreX     = 274
	audioMoreSz    = 19
)

var (
	audioDark   = color.RGBA{55, 55, 55, 255}
	audioLight  = color.RGBA{241, 243, 244, 255}
	audioTrack  = color.RGBA{182, 182, 182, 255}
	audioTimeSt = paint.TextStyle{Size: audioTimeSize, Weight: paint.Regular}
)

// AudioBar is the control a plain sound file gets, drawn like the browser's own: play, the time, a seek bar, the volume and a menu.
type AudioBar struct {
	Progress float32
	Playing  bool
	Time     string
	OnPlay   func()
	OnSeek   func(fraction float32)
}

func (a *AudioBar) Measure(*Context, float32) geom.Size { return geom.Size{W: audioW, H: audioH} }

func (a *AudioBar) Draw(c *Context, r geom.Rect) {
	r.W, r.H = audioW, audioH
	fill, ink := audioDark, rl.White
	if c.Theme.Bg.R > 128 {
		fill, ink = audioLight, color.RGBA{32, 33, 36, 255}
	}
	c.Paint.Fill(r, r.H/2, fill)
	mid := r.Y + r.H/2

	play := geom.Rect{X: r.X + audioPlayX - audioH/2, Y: r.Y, W: audioH, H: audioH}
	if c.Hovered(play) {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(play) {
			c.Claim()
			a.OnPlay()
		}
	}
	icon := "play"
	if a.Playing {
		icon = "pause"
	}
	c.Paint.Icon(icon, geom.Rect{X: r.X + audioPlayX - audioPlayIcon/2, Y: mid - audioPlayIcon/2, W: audioPlayIcon, H: audioPlayIcon}, ink)
	c.Paint.Text(a.Time, r.X+audioTimeX, mid-audioTimeLine/2, audioTimeLine, audioTimeSt, ink)

	seek := geom.Rect{X: r.X + audioSeekX, Y: mid - audioSeekH/2, W: audioSeekW, H: audioSeekH}
	c.Paint.Fill(seek, audioSeekH/2, audioTrack)
	if a.Progress > 0 {
		c.Paint.Fill(geom.Rect{X: seek.X, Y: seek.Y, W: seek.W * min(a.Progress, 1), H: seek.H}, audioSeekH/2, c.Theme.Accent)
	}
	hit := seek.Inset(0, -audioH/2+audioSeekH/2, 0, -audioH/2+audioSeekH/2)
	if c.Hovered(hit) {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(hit) {
			c.Claim()
			a.OnSeek(min(max((c.In.MouseX-seek.X)/seek.W, 0), 1))
		}
	}
	c.Paint.Icon("speaker-high", geom.Rect{X: r.X + audioSpeakerX, Y: mid - audioSpeakerSz/2, W: audioSpeakerSz, H: audioSpeakerSz}, ink)
	c.Paint.Icon("dots-three-outline-vertical", geom.Rect{X: r.X + audioMoreX - audioMoreSz/2, Y: mid - audioMoreSz/2, W: audioMoreSz, H: audioMoreSz}, ink)
}
