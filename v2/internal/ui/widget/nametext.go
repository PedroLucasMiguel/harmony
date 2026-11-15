package widget

import (
	"image/color"
	"math"
	"time"

	"harmony/v2/internal/people"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/redraw"
)

const nameMotionStep = 125 * time.Millisecond

// NameStyle is the look of the name of the person with that id, or of the one called name when the id is 0; nil when the
// person is not known, which draws as ordinary text.
func (c *Context) NameStyle(id int, name string) *people.Style {
	if c.People == nil {
		return nil
	}
	e := c.People.ByID(id)
	if id == 0 {
		e = c.People.ByName(name)
	}
	if e == nil {
		return nil
	}
	return &e.Style
}

// NameWidth is how wide DrawName makes the name.
func (c *Context) NameWidth(s string, look *people.Style, st paint.TextStyle) float32 {
	if look != nil {
		st = look.Family.Styled(st)
	}
	return c.Paint.TextWidth(s, st)
}

// DrawName draws a name in the font and colour its owner chose, or the role's colour, and base when neither colours it; a moving
// colour asks for a frame eight times a second while the name is drawn and the window is active. It returns the width.
func (c *Context) DrawName(s string, look *people.Style, x, top, lineHeight float32, st paint.TextStyle, base color.RGBA) float32 {
	if look == nil {
		c.Paint.Text(s, x, top, lineHeight, st, base)
		return c.Paint.TextWidth(s, st)
	}
	st = look.Family.Styled(st)
	switch look.Kind {
	case people.Solid:
		c.Paint.Text(s, x, top, lineHeight, st, color.RGBA{look.Color.R, look.Color.G, look.Color.B, base.A})
	case people.Moving:
		c.Paint.GradientText(s, x, top, lineHeight, st, look.Ring, namePhase(look.Speed))
		if c.active {
			redraw.After(nameMotionStep)
		}
	default:
		c.Paint.Text(s, x, top, lineHeight, st, base)
	}
	return c.Paint.TextWidth(s, st)
}

// namePhase is how far along its loop a moving colour is, the same for every name and held for a step of the motion.
func namePhase(speed float32) float32 {
	at := float64(time.Now().UnixMilli()/nameMotionStep.Milliseconds()*nameMotionStep.Milliseconds()) / 1000
	return float32(math.Mod(at/float64(speed), 1))
}

// BannerLook is how a banner is darkened and faded for its owner's dimming, 0 (as it is) to 100 (nearly black); nil is the default of 50.
func BannerLook(dim *int) (brightness uint8, opacity float32) {
	d := float32(50)
	if dim != nil {
		d = float32(*dim)
	}
	return uint8((1-d/100)*255 + 0.5), 1 - d*0.004
}
