// Package shareaudio decides where the sound of a screen share comes from and what to tell the person about it: all the
// system's sound (minus one application), one application's sound, or none.
package shareaudio

import (
	"os"

	"harmony/v2/internal/video/native"
)

// What is being shared.
const (
	Screen = "screen"
	Window = "window"
	Camera = "camera"
)

// What a window share does when its application's own sound cannot be captured.
const (
	FallbackSilent = "silent"
	FallbackSystem = "system"
)

// Via is where the sound comes from.
type Via int

const (
	None Via = iota
	System
	App
)

// Choice is what the person picked, and what the system can do.
type Choice struct {
	Kind    string
	Support native.AudioSupport
	// ExcludePID and ExcludeName are the application left out of a screen share's sound; 0 shares everything.
	ExcludePID  int
	ExcludeName string
	// WindowPID is the application that owns the shared window, 0 when it is not known.
	WindowPID int
	Fallback  string
}

// Plan is what will be done and the note to show under the share's controls.
type Plan struct {
	Via     Via
	Capture native.AudioCaptureParams
	// Note is the key of the sentence to show; Name and Reason fill its {name} and {reason}.
	Note   string
	Name   string
	Reason string
	// Warn marks a note that says something is missing.
	Warn bool
	// SafeToMonitor is whether hearing your own stream cannot feed the sound back into it.
	SafeToMonitor bool
}

const (
	noteSilentShare   = "app.sharing_without_audio"
	noteOnlyThis      = "app.viewers_will_hear_only_this"
	noteAllSystem     = "app.viewers_will_hear_all_system"
	noteSystemExcept  = "app.viewers_will_hear_system_audio"
	noteFallbackAll   = "audio.unavailable_all"
	noteFallbackNone  = "audio.unavailable_none"
	reasonNoAppSound  = "Per-application audio is not available on this system."
	reasonUnidentated = "The application behind that window could not be identified."
)

// Decide follows one rule: a whole screen sends everything the computer plays (minus the application chosen), a window
// sends only its application's sound, and where that cannot be done the person's fallback says silence or everything.
func Decide(c Choice) Plan {
	self := os.Getpid()
	switch {
	case c.Kind == Camera:
		return Plan{Note: noteSilentShare}
	case c.Kind == Screen:
		if !c.Support.System {
			return Plan{Note: noteFallbackNone, Reason: c.Support.Reason, Warn: true}
		}
		p := Plan{Via: System, Note: noteAllSystem}
		if c.ExcludePID != 0 && c.Support.Exclude {
			p.Capture.ExcludePID, p.Name, p.Note = c.ExcludePID, c.ExcludeName, noteSystemExcept
		}
		p.SafeToMonitor = c.Support.ExcludesSelf || p.Capture.ExcludePID == self
		return p
	case c.Support.App && c.WindowPID > 0:
		return Plan{Via: App, Capture: native.AudioCaptureParams{PID: c.WindowPID}, Note: noteOnlyThis, SafeToMonitor: c.WindowPID != self}
	}
	reason := c.Support.Reason
	switch {
	case reason == "" && c.Support.App:
		reason = reasonUnidentated
	case reason == "":
		reason = reasonNoAppSound
	}
	if c.Fallback == FallbackSystem && c.Support.System {
		return Plan{Via: System, Note: noteFallbackAll, Reason: reason, Warn: true, SafeToMonitor: c.Support.ExcludesSelf}
	}
	return Plan{Note: noteFallbackNone, Reason: reason, Warn: true}
}
