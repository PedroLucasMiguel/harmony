package imagecrop

import (
	"math"
	"testing"
)

func TestClampKeepsMaskCovered(t *testing.T) {
	m := Mask{X: 10, Y: 10, W: 100, H: 100, Circle: true}
	p := Clamp(Placement{S: 0.01, CX: 900, CY: -400, Deg: 30}, 400, 200, m)
	if low := MinScale(400, 200, m, 30); p.S < low-1e-9 {
		t.Fatalf("scale %v below %v", p.S, low)
	}
	rect := Mask{X: 0, Y: 0, W: 300, H: 100}
	p = Clamp(Placement{S: 1, CX: 5000, CY: 5000}, 600, 300, rect)
	if p.CX-300 > 150+1e-9 || p.CY-150 > 50+1e-9 {
		t.Fatalf("picture left the mask uncovered: %+v", p)
	}
}

func TestZoomKeepsPointFixed(t *testing.T) {
	m := Mask{W: 200, H: 200, Circle: true}
	p := Placement{S: 1, CX: 100, CY: 100}
	z := ZoomAt(p, 2, 100, 100, 400, 400, m)
	if math.Abs(z.S-2) > 1e-9 || math.Abs(z.CX-100) > 1e-9 {
		t.Fatalf("%+v", z)
	}
}
