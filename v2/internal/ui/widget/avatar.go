package widget

import (
	"image/color"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	avatarFill      = 0.12
	avatarRing      = 2
	avatarSpacing   = 0.02
	avatarDimAlpha  = 0.45
	avatarIconShare = 0.62
)

// Presence is how a person shows on the server.
type Presence int

const (
	Offline Presence = iota
	Online
	Idle
	DoNotDisturb
)

// AvatarDot is a presence dot sitting against an avatar's lower right corner.
type AvatarDot struct {
	Presence Presence
	Size     float32
	Ring     float32
	// Edge is the colour the avatar sits on, so the dot's ring blends into it.
	Edge   color.RGBA
	DX, DY float32
}

// Avatar is a person's initials on a faint disc, ringed in green while they speak.
type Avatar struct {
	Name string
	// Initials is what to show when the caller has worked it out already (see Initials); it saves doing so every frame.
	Initials string
	Size     float32
	Font     float32
	Speaking bool
	Dim      bool
	// Icon is a glyph drawn in place of the initials, for a group.
	Icon string
	// ID or Hash say whose picture to show: the person's id, or the picture's own hash; with neither the picture of the person called Name.
	ID   int
	Hash string
	// Source is where Hash is fetched from when it is not on the signed-in server.
	Source paint.Sizer
	// Dot, when its Size is set, is a presence dot against the lower right corner.
	Dot AvatarDot
}

func (a Avatar) Measure(*Context, float32) geom.Size { return geom.Size{W: a.Size, H: a.Size} }

// Initials is the two letters an avatar shows for a name.
func Initials(name string) string { return initials(name) }

func initials(name string) string { return initialsM.of(name) }

func (a Avatar) Draw(c *Context, r geom.Rect) {
	disc := geom.Rect{X: r.X, Y: r.Y, W: a.Size, H: a.Size}
	if a.Speaking {
		c.Paint.Stroke(disc.InsetAll(-avatarRing/2), a.Size/2+avatarRing/2, avatarRing, c.Theme.Live)
	}
	fill, ink := float32(avatarFill), c.Theme.Text
	if a.Dim {
		fill, ink = avatarFill*avatarDimAlpha, theme.WithAlpha(ink, avatarDimAlpha)
	}
	c.Paint.Fill(disc, a.Size/2, theme.WithAlpha(c.Theme.Tint, fill))
	if a.Icon != "" {
		side := a.Size * avatarIconShare
		c.Paint.Icon(a.Icon, geom.Rect{X: disc.X + (disc.W-side)/2, Y: disc.Y + (disc.H-side)/2, W: side, H: side}, c.Theme.Muted)
		if a.Dot.Size > 0 {
			a.drawDot(c, disc)
		}
		return
	}
	if a.drawFace(c, disc) {
		if a.Dot.Size > 0 {
			a.drawDot(c, disc)
		}
		return
	}
	style := paint.TextStyle{Size: a.Font, Weight: paint.Semibold, Spacing: a.Font * avatarSpacing}
	text := a.Initials
	if text == "" {
		text = initials(a.Name)
	}
	width := c.Paint.TextWidth(text, style)
	line := a.Font * 1.5
	c.Paint.Text(text, disc.X+(disc.W-width)/2, disc.Y+(disc.H-line)/2, line, style, ink)
	if a.Dot.Size > 0 {
		a.drawDot(c, disc)
	}
}

// drawFace draws the person's picture over the disc, and says whether it did: initials stand in until it is loaded.
func (a Avatar) drawFace(c *Context, disc geom.Rect) bool {
	hash := a.Hash
	if hash == "" && c.People != nil {
		hash = c.People.Avatar(a.ID, a.Name)
	}
	var src paint.Sizer = a.Source
	if src == nil && c.Faces != nil {
		src = c.Faces
	}
	if hash == "" || src == nil {
		return false
	}
	px := c.Paint.PixelSize(a.Size)
	alpha := float32(1)
	if a.Dim {
		alpha = avatarDimAlpha
	}
	return c.Paint.DrawSized(c.Paint.Sized(paint.Round, hash, px, px, src), disc, alpha)
}

func (a Avatar) drawDot(c *Context, disc geom.Rect) {
	d := &a.Dot
	box := geom.Rect{X: disc.Right() + d.DX - d.Size, Y: disc.Bottom() + d.DY - d.Size, W: d.Size, H: d.Size}
	cx, cy := box.X+box.W/2, box.Y+box.H/2
	c.Paint.Circle(cx, cy, d.Size/2, d.Edge)
	c.Paint.Circle(cx, cy, d.Size/2-d.Ring, presenceColor(c, d.Presence))
}

func presenceColor(c *Context, p Presence) color.RGBA {
	switch p {
	case Idle:
		return theme.StatusIdle
	case DoNotDisturb:
		return theme.StatusDoNotDisturb
	case Offline:
		return c.Theme.Muted
	}
	return theme.StatusOnline
}
