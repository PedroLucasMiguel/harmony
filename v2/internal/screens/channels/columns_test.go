package channels

import "testing"

func TestDraggedWidth(t *testing.T) {
	cases := []struct {
		name  string
		col   column
		w     float32
		space float32
		want  int
	}{
		{"inside the limits", colSide, 300, 1200, 300},
		{"too narrow is the least", colSide, 20, 1200, 160},
		{"too wide is the most", colMembers, 900, 5000, 480},
		{"a share of a small window caps it", colSide, 500, 800, 304},
		{"near the usual width is the usual one", colSide, 261, 1200, 0},
		{"just outside the usual width stays", colSide, 263, 1200, 263},
	}
	for _, c := range cases {
		if got := dragged(c.col, c.w, c.space); got != c.want {
			t.Errorf("%s: dragged(%v, %v) = %d, want %d", c.name, c.w, c.space, got, c.want)
		}
	}
}
