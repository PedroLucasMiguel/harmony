package debuglog

import (
	"fmt"
	"strings"
	"testing"
)

func TestRingKeepsTheNewestLines(t *testing.T) {
	Clear()
	for i := range ringSize + 50 {
		Write("APP", fmt.Sprintf("line %d", i))
	}
	lines := Lines()
	if len(lines) != ringSize || !strings.HasSuffix(lines[0], "line 50\n") || !strings.HasSuffix(lines[ringSize-1], fmt.Sprintf("line %d\n", ringSize+49)) {
		t.Fatalf("ring holds %d lines, first %q", len(lines), lines[0])
	}
}
