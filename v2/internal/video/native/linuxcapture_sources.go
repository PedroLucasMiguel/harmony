//go:build linux

package native

import "os"

// listSources has one screen: under Wayland the desktop's own picker (the screen cast portal) asks which screen or window
// when the share starts, and under X11 it is the primary monitor. Windows are not listed.
func listSources() []SourceInfo {
	name := "Screen"
	if os.Getenv("WAYLAND_DISPLAY") != "" || os.Getenv("XDG_SESSION_TYPE") == "wayland" {
		name = "Screen or window (the system asks)"
	}
	return []SourceInfo{{ID: "screen:0", Kind: KindScreen, Name: name}}
}

func sourceThumbnail(string, int) ([]byte, int, int, bool) { return nil, 0, 0, false }

func screenAccess() bool { return true }

func openScreenSettings() {}
