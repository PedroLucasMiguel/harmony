package hotkey

import "os"

// On X11 a program can grab a key on the root window and is told of its press and release. On Wayland it cannot:
// the compositor keeps keys to itself, and the only way is the GlobalShortcuts portal, where the desktop owns the
// binding and the person confirms or changes the key in its own dialog.

func onWayland() bool {
	return os.Getenv("XDG_SESSION_TYPE") == "wayland" || (os.Getenv("WAYLAND_DISPLAY") != "" && os.Getenv("DISPLAY") == "")
}

func supported() string {
	if onWayland() {
		if portalAvailable() {
			return ErrNone
		}
		return ErrWayland
	}
	if os.Getenv("DISPLAY") == "" || !loadX11() {
		return ErrUnavailable
	}
	return ErrNone
}

func newBackend(emit func(id string, down bool)) backend {
	if onWayland() {
		return &portalBackend{emit: emit}
	}
	if os.Getenv("DISPLAY") == "" || !loadX11() {
		return nil
	}
	return &x11Backend{emit: emit}
}
