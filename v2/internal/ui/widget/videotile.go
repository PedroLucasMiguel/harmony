package widget

import (
	"image/color"
	"strconv"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	videoTileRadius = 8
	tileCapPadX     = 6.4
	tileCapPadY     = 2.4
	tileCapGap      = 6.4
	tileFace        = 18.85
	tileFaceFont    = 9.92
	tileNameSize    = 12
	tileMarkSize    = 11.2
	tileMarkGap     = 4.8
	tileBtnIcon     = 14.4
	tileBtnPadX     = 3.2
	tileBtnPadY     = 1.6
	tileBtnGap      = 3.2
	tileBtnRadius   = 4
	tileCornerInset = 4.8
	tileCornerPadX  = 5.6
	tileCornerPadY  = 3.2
	tileRingSpeak   = 3
	tileRingHover   = 2
	tileHoverFaint  = 0.6
	tileHatchBand   = 10
	tileHatchPeriod = 20
	tileHatchAlpha  = 0.03
	tileBtnHover    = 0.18
	tileCornerBack  = 0.55
	tileCapBack     = 0.55
	tileCornerOn    = 0.8
	tileErrorSize   = 13
	tileSlashTilt   = 0.34
	tileVolumeW     = 72
	tileVolumeLabel = 34
	tileVolumeSize  = 11
)

var tileBlack = color.RGBA{A: 255}

// TileAction is what a press on a video tile asked for.
type TileAction int

const (
	TileNone TileAction = iota
	TileClick
	TileClose
	TileFullscreen
	TilePreview
	TileMute
	TileMonitor
)

// VideoTile is somebody's camera or screen: the picture fitted into a black tile, a caption over its foot with who it is
// and what they are doing, a ring while they talk, and the buttons that appear under the pointer. Your own tiles show
// nothing (hatched) until the preview is on.
type VideoTile struct {
	Surface *Surface
	Name    string
	Face    string
	Error   string

	Own         bool
	Mirror      bool
	Preview     bool
	Speaking    bool
	Muted       bool
	ForceMuted  bool
	Deafened    bool
	Focused     bool
	Compact     bool
	Flat        bool
	Controls    bool
	HideCaption bool
	// Volume is the slider for how loud a share is played; set it on somebody else's screen share to show the mute button,
	// the slider and the level (Level, in percent). NoAudio marks a share with no sound.
	Volume  *Slider
	Level   int
	NoAudio bool
	// Monitor shows the button that plays your own share to you; Monitoring says it is on and CanMonitor that it can be.
	Monitor    bool
	Monitoring bool
	CanMonitor bool
	// HiddenTitle and HiddenText say, over the hatching, why your own preview shows nothing.
	HiddenTitle, HiddenText string
}

// Show draws the tile in r and reports what was pressed.
func (t VideoTile) Show(c *Context, r geom.Rect) TileAction {
	hovered := c.Hovered(r)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	radius := float32(videoTileRadius)
	if t.Flat {
		radius = 0
	}
	backdrop := tileBlack
	if t.Own && !t.Preview {
		backdrop = c.Theme.Bg
	}
	c.Paint.Fill(r, radius, backdrop)
	switch {
	case t.Own && !t.Preview:
		drawHatch(c, r)
		t.drawHidden(c, r)
	case t.Surface != nil && t.Surface.live:
		t.drawPicture(c, r)
	case t.Error != "":
		style := paint.TextStyle{Size: tileErrorSize, Weight: paint.Regular}
		width := c.Paint.TextWidth(t.Error, style)
		line := float32(tileErrorSize * 1.5)
		c.Paint.TextIn(r, t.Error, r.X+max(0, (r.W-width)/2), r.Y+(r.H-line)/2, line, style, c.Theme.Muted)
	}

	action := TileNone
	if !t.HideCaption {
		action = t.drawCaption(c, r, hovered)
	}
	if t.Own && (hovered || t.Controls || !t.Preview || t.Monitoring) {
		eye := t.cornerButton(r)
		if tileButton(c, eye, "eye", t.Preview, true) {
			action = TilePreview
		}
		if t.Monitor {
			ear := geom.Rect{X: eye.X - tileBtnGap - eye.W, Y: eye.Y, W: eye.W, H: eye.H}
			if tileButtonFaded(c, ear, "headphones", t.Monitoring, !t.CanMonitor) && t.CanMonitor {
				action = TileMonitor
			}
		}
	}
	if radius > 0 {
		c.Paint.Corners(r, radius, c.Theme.Bg)
	}
	t.drawRing(c, r, radius, hovered)

	if action == TileNone && hovered && c.In.Pressed {
		action = TileClick
	}
	if action != TileNone {
		c.Claim()
	}
	return action
}

func (t VideoTile) drawPicture(c *Context, r geom.Rect) {
	w, h := t.Surface.Size()
	if w == 0 || h == 0 {
		return
	}
	scale := min(r.W/float32(w), r.H/float32(h))
	fit := geom.Rect{W: float32(w) * scale, H: float32(h) * scale}
	fit.X, fit.Y = r.X+(r.W-fit.W)/2, r.Y+(r.H-fit.H)/2
	c.Paint.Texture(t.Surface.tex, fit, t.Mirror)
}

func (t VideoTile) captionHeight() float32 { return tileFace + 2*tileCapPadY }

func (t VideoTile) cornerButton(r geom.Rect) geom.Rect {
	size := float32(tileBtnIcon + 2*tileCornerPadX)
	return geom.Rect{X: r.Right() - tileCornerInset - size, Y: r.Y + tileCornerInset, W: size, H: tileBtnIcon + 2*tileCornerPadY}
}

func (t VideoTile) drawCaption(c *Context, r geom.Rect, hovered bool) TileAction {
	bar := geom.Rect{X: r.X, Y: r.Bottom() - t.captionHeight(), W: r.W, H: t.captionHeight()}
	c.Paint.Fill(bar, 0, theme.WithAlpha(tileBlack, tileCapBack))
	x := bar.X + tileCapPadX
	if t.Face != "" {
		face := Avatar{Name: t.Face, Size: tileFace, Font: tileFaceFont, Speaking: t.Speaking}
		face.Draw(c, geom.Rect{X: x, Y: bar.Y + tileCapPadY, W: tileFace, H: tileFace})
		x += tileFace + tileCapGap
	}

	action := TileNone
	right := bar.Right() - tileCapPadX
	if hovered || t.Controls {
		btn := float32(tileBtnIcon + 2*tileBtnPadX)
		height := float32(tileBtnIcon + 2*tileBtnPadY)
		top := bar.Y + (bar.H-height)/2
		for _, b := range [...]struct {
			icon   string
			action TileAction
			show   bool
		}{{"x", TileClose, !t.Own}, {"corners-out", TileFullscreen, !t.Compact}} {
			if !b.show {
				continue
			}
			right -= btn
			if tileButton(c, geom.Rect{X: right, Y: top, W: btn, H: height}, b.icon, false, false) {
				action = b.action
			}
			right -= tileBtnGap
		}
		right += tileBtnGap
		if t.Volume != nil && !t.Compact {
			if volume := t.drawVolume(c, bar, top, btn, height, right-tileBtnGap); volume != TileNone {
				action = volume
			}
			right -= tileBtnGap + tileVolumeLabel + tileBtnGap + tileVolumeW + tileBtnGap + btn
		}
	}

	style := paint.TextStyle{Size: tileNameSize, Weight: paint.Semibold}
	line := float32(tileNameSize * 1.5)
	clip := geom.Rect{X: x, Y: bar.Y, W: max(0, right-tileCapGap-x), H: bar.H}
	c.Paint.TextIn(clip, t.Name, x, bar.Y+(bar.H-line)/2, line, style, c.Theme.Text)
	x += min(c.Paint.TextWidth(t.Name, style), clip.W) + tileCapGap
	t.drawMarks(c, x, bar)
	return action
}

func (t VideoTile) drawMarks(c *Context, x float32, bar geom.Rect) {
	y := bar.Y + (bar.H-tileMarkSize)/2
	mark := func(icon string, ink color.RGBA, slashed bool) {
		box := geom.Rect{X: x, Y: y, W: tileMarkSize, H: tileMarkSize}
		c.Paint.Icon(icon, box, ink)
		if slashed {
			dy := box.W * tileSlashTilt / 2
			c.Paint.Line(box.X-box.W*0.05, box.Y+box.H/2+dy, box.Right()+box.W*0.05, box.Y+box.H/2-dy, 1.5, ink)
		}
		x += tileMarkSize + tileMarkGap
	}
	if t.NoAudio {
		mark("speaker-x", c.Theme.Muted, false)
	}
	switch {
	case t.ForceMuted:
		mark("microphone-slash", c.Theme.DangerSoft, false)
	case t.Muted:
		mark("microphone-slash", c.Theme.Text, false)
	}
	if t.Deafened {
		mark("headphones", c.Theme.Text, true)
	}
}

func (t VideoTile) drawRing(c *Context, r geom.Rect, radius float32, hovered bool) {
	switch {
	case t.Speaking:
		c.Paint.Stroke(r, radius, tileRingSpeak, c.Theme.Live)
	case hovered && t.Focused:
		c.Paint.Stroke(r, radius, tileRingHover, theme.WithAlpha(c.Theme.Accent, tileHoverFaint))
	case hovered:
		c.Paint.Stroke(r, radius, tileRingHover, c.Theme.Accent)
	}
}

// tileButton is a small glyph button over a picture; backdrop gives it the dark plate the corner buttons sit on.
func tileButton(c *Context, r geom.Rect, icon string, on, backdrop bool) bool {
	hovered := c.Hovered(r)
	switch {
	case on:
		c.Paint.Fill(r, tileBtnRadius, theme.WithAlpha(c.Theme.Accent, tileCornerOn))
	case hovered:
		c.Paint.Fill(r, tileBtnRadius, theme.WithAlpha(c.Theme.Tint, tileBtnHover))
	case backdrop:
		c.Paint.Fill(r, tileBtnRadius, theme.WithAlpha(tileBlack, tileCornerBack))
	}
	c.Paint.Icon(icon, geom.Rect{X: r.X + (r.W-tileBtnIcon)/2, Y: r.Y + (r.H-tileBtnIcon)/2, W: tileBtnIcon, H: tileBtnIcon}, c.Theme.Text)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	return hovered && c.In.Pressed
}

// drawHatch fills r with the faint diagonal stripes of a tile that has nothing to show.
func drawHatch(c *Context, r geom.Rect) {
	ink := theme.WithAlpha(c.Theme.Tint, tileHatchAlpha)
	const root2 = 1.4142135
	corner := r.Right() + r.Bottom()
	c.Paint.PushClip(r)
	for s := float32(tileHatchBand / 2 * root2); s < r.W+r.H; s += tileHatchPeriod * root2 {
		k := corner - s
		c.Paint.Line(k-r.Bottom(), r.Bottom(), k-r.Y, r.Y, tileHatchBand, ink)
	}
	c.Paint.PopClip()
}

const (
	hiddenWidth = 420
	hiddenTitle = 16
	hiddenText  = 13
)

// drawHidden centres a title and a few lines over the hatching of a preview that is off.
func (t VideoTile) drawHidden(c *Context, r geom.Rect) {
	if t.HiddenTitle == "" || r.W < 160 {
		return
	}
	w := min(hiddenWidth, r.W-40)
	title := &Text{Content: t.HiddenTitle, Style: paint.TextStyle{Size: hiddenTitle, Weight: paint.Bold}, Tone: ToneText}
	body := &Text{Content: t.HiddenText, Style: paint.TextStyle{Size: hiddenText, Weight: paint.Regular}, Tone: ToneMuted, Wrap: true}
	th, bh := title.Measure(c, w).H, body.Measure(c, w).H
	y := r.Y + (r.H-th-6-bh)/2
	title.Draw(c, geom.Rect{X: r.X + (r.W-w)/2, Y: y, W: w, H: th})
	body.Draw(c, geom.Rect{X: r.X + (r.W-w)/2, Y: y + th + 6, W: w, H: bh})
}

// drawVolume draws the mute button, the slider and the level to the left of right, and reports a press on the button.
func (t VideoTile) drawVolume(c *Context, bar geom.Rect, top, btn, height, right float32) TileAction {
	style := paint.TextStyle{Size: tileVolumeSize, Weight: paint.Regular}
	label := strconv.Itoa(t.Level) + "%"
	line := float32(tileVolumeSize * 1.5)
	right -= tileVolumeLabel
	c.Paint.TextIn(geom.Rect{X: right, Y: bar.Y, W: tileVolumeLabel, H: bar.H}, label, right+tileVolumeLabel-c.Paint.TextWidth(label, style), bar.Y+(bar.H-line)/2, line, style, c.Theme.Muted)
	right -= tileBtnGap + tileVolumeW
	t.Volume.Draw(c, geom.Rect{X: right, Y: bar.Y + (bar.H-sliderBox)/2, W: tileVolumeW, H: sliderBox})
	right -= tileBtnGap + btn
	icon := "speaker-high"
	if t.Level == 0 {
		icon = "speaker-x"
	}
	if tileButton(c, geom.Rect{X: right, Y: top, W: btn, H: height}, icon, false, false) {
		return TileMute
	}
	return TileNone
}

// tileButtonFaded is tileButton that shows dimmed when it cannot be used.
func tileButtonFaded(c *Context, r geom.Rect, icon string, on, faded bool) bool {
	if !faded {
		return tileButton(c, r, icon, on, true)
	}
	c.Paint.Fill(r, tileBtnRadius, theme.WithAlpha(tileBlack, tileCornerBack))
	c.Paint.Icon(icon, geom.Rect{X: r.X + (r.W-tileBtnIcon)/2, Y: r.Y + (r.H-tileBtnIcon)/2, W: tileBtnIcon, H: tileBtnIcon}, theme.WithAlpha(c.Theme.Muted, tileHoverFaint))
	return c.Hovered(r) && c.In.Pressed
}
