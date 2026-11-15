package shareaudio

import (
	"testing"

	"harmony/v2/internal/video/native"
)

func TestDecide(t *testing.T) {
	all := native.AudioSupport{System: true, Exclude: true, App: true}
	linux := native.AudioSupport{System: true}
	for _, tc := range []struct {
		name string
		in   Choice
		via  Via
		note string
		pid  int
	}{
		{"screen", Choice{Kind: Screen, Support: all}, System, noteAllSystem, 0},
		{"screen minus app", Choice{Kind: Screen, Support: all, ExcludePID: 7, ExcludeName: "Chat"}, System, noteSystemExcept, 0},
		{"window with app audio", Choice{Kind: Window, Support: all, WindowPID: 9}, App, noteOnlyThis, 9},
		{"window, unknown app, silent", Choice{Kind: Window, Support: all, Fallback: FallbackSilent}, None, noteFallbackNone, 0},
		{"window, no per-app audio, system", Choice{Kind: Window, Support: linux, WindowPID: 9, Fallback: FallbackSystem}, System, noteFallbackAll, 0},
		{"camera", Choice{Kind: Camera, Support: all}, None, noteSilentShare, 0},
		{"nothing capturable", Choice{Kind: Screen}, None, noteFallbackNone, 0},
	} {
		got := Decide(tc.in)
		if got.Via != tc.via || got.Note != tc.note || got.Capture.PID != tc.pid {
			t.Errorf("%s: got via %d note %s pid %d", tc.name, got.Via, got.Note, got.Capture.PID)
		}
	}
	if p := Decide(Choice{Kind: Screen, Support: all, ExcludePID: 7}); p.Capture.ExcludePID != 7 {
		t.Errorf("exclude pid lost: %+v", p.Capture)
	}
	if p := Decide(Choice{Kind: Screen, Support: linux, ExcludePID: 7}); p.Capture.ExcludePID != 0 || p.Note != noteAllSystem {
		t.Errorf("a system that cannot exclude must not pretend to: %+v", p)
	}
}
