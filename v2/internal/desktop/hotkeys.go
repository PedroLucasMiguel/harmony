package desktop

import (
	"sort"
	"strconv"
	"strings"

	"harmony/v2/internal/hotkey"
)

// The ids of the actions a key can be bound to; a soundpad clip is "clip:<id>".
const (
	ActionMute   = "mute"
	ActionDeafen = "deafen"
	ActionCamera = "camera"
	ActionPTT    = "ptt"
	clipPrefix   = "clip:"
)

// Actions are the fixed ones, in the order the page lists them.
var Actions = []string{ActionMute, ActionDeafen, ActionCamera}

// Binding is the key an action is bound to, from the saved settings.
func (d *Desktop) Binding(id string) string {
	s := d.opt.Settings
	switch {
	case id == ActionPTT:
		return s.PushToTalkKey
	case strings.HasPrefix(id, clipPrefix):
		return s.ClipHotkeys[d.serverKey()][strings.TrimPrefix(id, clipPrefix)]
	}
	return s.Hotkeys[id]
}

func (d *Desktop) serverKey() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.server
}

// SetBinding binds an action to a key, or unbinds it with an empty one. A key can do one thing: whatever else had it lets it go.
func (d *Desktop) SetBinding(id, accelerator string) {
	s := d.opt.Settings
	server := d.serverKey()
	same := func(other string) bool { return accelerator != "" && strings.EqualFold(other, accelerator) }
	if same(s.PushToTalkKey) {
		s.PushToTalkKey = ""
	}
	for key, value := range s.Hotkeys {
		if same(value) {
			s.Hotkeys[key] = ""
		}
	}
	for clip, value := range s.ClipHotkeys[server] {
		if same(value) {
			s.ClipHotkeys[server][clip] = ""
		}
	}
	switch {
	case id == ActionPTT:
		s.PushToTalkKey = accelerator
	case strings.HasPrefix(id, clipPrefix):
		if s.ClipHotkeys == nil {
			s.ClipHotkeys = map[string]map[string]string{}
		}
		if s.ClipHotkeys[server] == nil {
			s.ClipHotkeys[server] = map[string]string{}
		}
		s.ClipHotkeys[server][strings.TrimPrefix(id, clipPrefix)] = accelerator
	default:
		if s.Hotkeys == nil {
			s.Hotkeys = map[string]string{}
		}
		s.Hotkeys[id] = accelerator
	}
	s.Save()
	d.SyncHotkeys()
}

// HotkeyResult is what the system said about a binding at the last sync.
func (d *Desktop) HotkeyResult(id string) (hotkey.Result, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	r, ok := d.results[id]
	return r, ok
}

// Pause lets go of every global key, so that pressing a combination that is already bound is recorded instead of acted on.
func (d *Desktop) Pause() {
	d.mu.Lock()
	d.paused = true
	d.mu.Unlock()
	d.hot.Set(nil)
}

// Resume binds the keys again after a Pause, or after any change to them.
func (d *Desktop) Resume() {
	d.mu.Lock()
	d.paused = false
	d.mu.Unlock()
	d.SyncHotkeys()
}

// SyncHotkeys registers what the settings say is bound. Push to talk is only a binding while it is turned on.
func (d *Desktop) SyncHotkeys() {
	d.mu.Lock()
	if d.paused {
		d.mu.Unlock()
		return
	}
	d.mu.Unlock()
	s := d.opt.Settings
	var bindings []hotkey.Binding
	for _, id := range Actions {
		if key := s.Hotkeys[id]; key != "" {
			bindings = append(bindings, hotkey.Binding{ID: id, Accelerator: key})
		}
	}
	if s.PushToTalk && s.PushToTalkKey != "" {
		bindings = append(bindings, hotkey.Binding{ID: ActionPTT, Accelerator: s.PushToTalkKey, Listen: true})
	}
	if session := d.session.Load(); session != nil {
		clips := s.ClipHotkeys[d.serverKey()]
		ids := make([]string, 0, len(clips))
		for _, clip := range session.Clips() {
			if clips[strconv.Itoa(clip.ID)] != "" {
				ids = append(ids, strconv.Itoa(clip.ID))
			}
		}
		sort.Strings(ids)
		for _, id := range ids {
			bindings = append(bindings, hotkey.Binding{ID: clipPrefix + id, Accelerator: clips[id]})
		}
	}
	results := d.hot.Set(bindings)
	d.mu.Lock()
	clear(d.results)
	for _, r := range results {
		d.results[r.ID] = r
	}
	d.mu.Unlock()
	d.opt.Redraw()
}

// fire is a key going down or up, from the hotkey thread.
func (d *Desktop) fire(id string, down bool) {
	session := d.session.Load()
	if session == nil {
		return
	}
	if id == ActionPTT {
		session.SetPTTHeld(down)
		return
	}
	if !down || !session.InVoice() {
		return
	}
	switch {
	case id == ActionMute:
		session.SetMuted(!session.State().Muted)
	case id == ActionDeafen:
		session.SetDeafened(!session.State().Deafened)
	case id == ActionCamera:
		d.opt.Post(d.opt.ToggleCamera)
	case strings.HasPrefix(id, clipPrefix):
		if n, err := strconv.Atoi(strings.TrimPrefix(id, clipPrefix)); err == nil {
			go func() { _ = session.PlayClip(n) }()
		}
	}
	d.opt.Redraw()
}
