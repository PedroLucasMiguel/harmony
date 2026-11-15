// Package imagecrop cuts a picture to the shape it is shown in (a circle for a profile picture, a strip for a banner) and
// writes the result as the file the server keeps: a JPEG that fits, a PNG for a logo, or a GIF that still moves.
//
// Everything is in the coordinates of the viewport the picture is edited in: a placement says where the picture's centre is,
// how many times its natural size it is drawn at, and how far it is turned (clockwise); the mask says what part of the
// viewport is kept.
package imagecrop

import "math"

// MaxZoom is the most a picture is enlarged beyond the size that just covers the mask.
const MaxZoom = 8

// Mask is the part of the viewport that is kept.
type Mask struct {
	X, Y, W, H float64
	Circle     bool
}

// Placement is where the picture is: its centre, the scale it is drawn at, and its turn in degrees.
type Placement struct {
	S, CX, CY, Deg float64
}

func rad(deg float64) float64 { return deg * math.Pi / 180 }

// extents is half the width and half the height of what the mask covers, seen from the picture's own turned frame.
func extents(m Mask, deg float64) (ex, ey float64) {
	if m.Circle {
		return m.W / 2, m.W / 2
	}
	c, s := math.Abs(math.Cos(rad(deg))), math.Abs(math.Sin(rad(deg)))
	return (m.W*c + m.H*s) / 2, (m.W*s + m.H*c) / 2
}

// MinScale is the smallest the picture may be drawn and still cover the mask, at this turn.
func MinScale(iw, ih float64, m Mask, deg float64) float64 {
	ex, ey := extents(m, deg)
	return math.Max(2*ex/iw, 2*ey/ih)
}

// Start is the picture centred on the mask, as small as it may be.
func Start(iw, ih float64, m Mask) Placement {
	return Placement{S: MinScale(iw, ih, m, 0), CX: m.X + m.W/2, CY: m.Y + m.H/2}
}

// Clamp brings a placement to the nearest one that leaves no part of the mask empty.
func Clamp(p Placement, iw, ih float64, m Mask) Placement {
	deg := math.Mod(math.Mod(p.Deg+180, 360)+360, 360) - 180
	low := MinScale(iw, ih, m, deg)
	s := math.Min(math.Max(p.S, low), low*MaxZoom)
	ex, ey := extents(m, deg)
	roomX, roomY := math.Max(0, s*iw/2-ex), math.Max(0, s*ih/2-ey)
	mx, my := m.X+m.W/2, m.Y+m.H/2
	cos, sin := math.Cos(rad(deg)), math.Sin(rad(deg))
	dx, dy := mx-p.CX, my-p.CY
	qx := math.Min(roomX, math.Max(-roomX, dx*cos+dy*sin))
	qy := math.Min(roomY, math.Max(-roomY, -dx*sin+dy*cos))
	return Placement{S: s, Deg: deg, CX: mx - (qx*cos - qy*sin), CY: my - (qx*sin + qy*cos)}
}

// ZoomAt zooms by factor about a point of the viewport, which stays under whatever it was over.
func ZoomAt(p Placement, factor, px, py, iw, ih float64, m Mask) Placement {
	low := MinScale(iw, ih, m, p.Deg)
	k := math.Min(math.Max(p.S*factor, low), low*MaxZoom) / p.S
	return Clamp(Placement{S: p.S * k, Deg: p.Deg, CX: px - (px-p.CX)*k, CY: py - (py-p.CY)*k}, iw, ih, m)
}

// RotateBy turns by delta degrees about the middle of the mask.
func RotateBy(p Placement, delta, iw, ih float64, m Mask) Placement {
	mx, my := m.X+m.W/2, m.Y+m.H/2
	a := rad(delta)
	dx, dy := p.CX-mx, p.CY-my
	return Clamp(Placement{S: p.S, Deg: p.Deg + delta, CX: mx + dx*math.Cos(a) - dy*math.Sin(a), CY: my + dx*math.Sin(a) + dy*math.Cos(a)}, iw, ih, m)
}

// ZoomFraction is where the scale sits between the smallest and the largest, 0 to 1.
func ZoomFraction(p Placement, iw, ih float64, m Mask) float64 {
	return math.Log(p.S/MinScale(iw, ih, m, p.Deg)) / math.Log(MaxZoom)
}

// ScaleAt is the scale for a zoom fraction at the placement's turn.
func ScaleAt(fraction, iw, ih float64, m Mask, deg float64) float64 {
	return MinScale(iw, ih, m, deg) * math.Pow(MaxZoom, fraction)
}
