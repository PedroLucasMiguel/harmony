package widget

import "testing"

func TestGridColumns(t *testing.T) {
	for _, c := range []struct {
		count int
		w, h  float32
		want  int
	}{
		{1, 400, 600, 1},
		{2, 438, 604, 1},
		{2, 1000, 500, 2},
		{3, 438, 604, 1},
		{4, 1000, 600, 2},
		{6, 1400, 700, 3},
	} {
		if got := GridColumns(c.count, c.w, c.h, 8); got != c.want {
			t.Errorf("%d tiles in %vx%v: %d columns, want %d", c.count, c.w, c.h, got, c.want)
		}
	}
}
