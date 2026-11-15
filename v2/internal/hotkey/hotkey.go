// Package hotkey binds key combinations that work while the window is not in front: push to talk, mute, deafen. Each system has its own file; none needs cgo.
package hotkey

import (
	"runtime"
	"strings"
)

// Error codes a binding can fail with; the settings page turns them into words (hotkeys.err_*).
const (
	ErrNone        = ""
	ErrInUse       = "in_use"
	ErrDuplicate   = "duplicate"
	ErrInvalid     = "invalid"
	ErrUnavailable = "hook"
	ErrPermission  = "permission"
	ErrWayland     = "wayland"
)

type Binding struct {
	ID          string
	Accelerator string
	// Listen binds without taking the key from other programs, which is what push to talk wants of a bare key. Where the system cannot listen without taking, the key is taken.
	Listen bool
}

type Result struct {
	ID    string
	OK    bool
	Error string
}

type entry struct {
	id     string
	combo  Combo
	listen bool
}

type backend interface {
	// set replaces every registration and returns an error code for each entry ("" when it works).
	set(entries []entry) []string
	close()
}

// Manager holds the registrations; OnEvent is called from a thread of its own, so it must return quickly.
type Manager struct {
	OnEvent func(id string, down bool)
	b       backend
}

// Listens says whether a binding can hear a key without taking it from other programs; X11 can only grab, so push to talk there takes its key like any hotkey.
func Listens() bool { return runtime.GOOS != "linux" }

// Supported says whether this system can have global hotkeys at all, with ErrWayland and the like for why not.
func Supported() string { return supported() }

// Set replaces every binding at once, so there is nothing to keep in step with the settings.
func (m *Manager) Set(bindings []Binding) []Result {
	results := make([]Result, len(bindings))
	var entries []entry
	var at []int
	seen := map[string]bool{}
	for i, b := range bindings {
		results[i] = Result{ID: b.ID}
		accel := strings.TrimSpace(b.Accelerator)
		combo, ok := Parse(accel)
		switch {
		case !ok:
			results[i].Error = ErrInvalid
		case seen[strings.ToLower(accel)]:
			results[i].Error = ErrDuplicate
		default:
			seen[strings.ToLower(accel)] = true
			entries = append(entries, entry{b.ID, combo, b.Listen})
			at = append(at, i)
		}
	}
	if m.b == nil && len(entries) > 0 {
		m.b = newBackend(func(id string, down bool) {
			if m.OnEvent != nil {
				m.OnEvent(id, down)
			}
		})
	}
	if m.b == nil {
		return results
	}
	codes := m.b.set(entries)
	for j, code := range codes {
		results[at[j]].Error = code
	}
	for i := range results {
		results[i].OK = results[i].Error == ErrNone
	}
	return results
}

// Close drops every binding and stops the threads.
func (m *Manager) Close() {
	if m.b != nil {
		m.b.close()
		m.b = nil
	}
}
