package native

import (
	"strconv"
	"strings"
)

// SourceKind says what a SourceInfo is.
type SourceKind string

const (
	KindScreen SourceKind = "screen"
	KindWindow SourceKind = "window"
	KindCamera SourceKind = "camera"
)

// SourceInfo is something the person may share: a screen, a window or a camera.
type SourceInfo struct {
	// ID is what CaptureParams.SourceID takes: "screen:<n>", "window:<n>" or "camera:<id>".
	ID   string
	Kind SourceKind
	Name string
	// App is the program a window belongs to.
	App string
	// W and H are the size in points, 0 when the system does not say.
	W, H int
}

// Sources lists the screens, windows and cameras the system offers, screens first. A system that cannot list windows
// (Windows and Linux for now) lists screens and cameras only. It may take a moment: callers run it off the frame loop.
func Sources() []SourceInfo {
	out := listSources()
	for _, c := range listCameras() {
		out = append(out, SourceInfo{ID: "camera:" + c.ID, Kind: KindCamera, Name: c.Name})
	}
	return out
}

// Thumbnail is a small picture of a screen or window source, RGBA, w by h, at most maxW wide; ok is false when the system
// gives none (a camera, a source that went away, no permission).
func Thumbnail(id string, maxW int) (rgba []byte, w, h int, ok bool) {
	kind, _ := ParseSourceID(id)
	if kind == KindCamera || maxW < 16 {
		return nil, 0, 0, false
	}
	return sourceThumbnail(id, maxW)
}

// ParseSourceID splits "screen:3" into its kind and the rest.
func ParseSourceID(id string) (SourceKind, string) {
	kind, rest, _ := strings.Cut(id, ":")
	return SourceKind(kind), rest
}

func parseSourceNumber(id string, want SourceKind) (uint32, bool) {
	kind, rest := ParseSourceID(id)
	n, err := strconv.ParseUint(rest, 10, 32)
	return uint32(n), kind == want && err == nil
}

// ScreenAccess says whether the system lets this program see the screen. Only macOS asks; elsewhere it is always true.
func ScreenAccess() bool { return screenAccess() }

// OpenScreenAccessSettings opens the system page where screen recording is allowed (macOS); elsewhere it does nothing.
func OpenScreenAccessSettings() { openScreenSettings() }
