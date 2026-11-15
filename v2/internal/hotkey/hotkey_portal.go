//go:build linux

package hotkey

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/godbus/dbus/v5"
)

const (
	portalName     = "org.freedesktop.portal.Desktop"
	portalPath     = "/org/freedesktop/portal/desktop"
	portalShortcut = "org.freedesktop.portal.GlobalShortcuts"
	portalRequest  = "org.freedesktop.portal.Request"
	portalWait     = 2 * time.Minute
)

func portalAvailable() bool {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return false
	}
	defer conn.Close()
	v, err := conn.Object(portalName, portalPath).GetProperty(portalShortcut + ".version")
	return err == nil && v.Value() != nil
}

// portalBackend asks the desktop for the shortcuts. The key written here is only a suggestion: the desktop shows its own
// dialog and the person may change it, so the binding that works is the one the desktop holds.
type portalBackend struct {
	emit func(id string, down bool)

	mu      sync.Mutex
	conn    *dbus.Conn
	signals chan *dbus.Signal
	session dbus.ObjectPath
	stop    chan struct{}
}

func portalToken() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "harmony" + hex.EncodeToString(b[:])
}

func (b *portalBackend) open() error {
	if b.conn != nil {
		return nil
	}
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return err
	}
	b.conn, b.signals, b.stop = conn, make(chan *dbus.Signal, 32), make(chan struct{})
	conn.Signal(b.signals)
	res, err := b.request(portalShortcut+".CreateSession", func(handle string) []any {
		return []any{map[string]dbus.Variant{"handle_token": dbus.MakeVariant(handle), "session_handle_token": dbus.MakeVariant(portalToken())}}
	})
	if err != nil {
		b.shut()
		return err
	}
	switch v := res["session_handle"].Value().(type) {
	case string:
		b.session = dbus.ObjectPath(v)
	case dbus.ObjectPath:
		b.session = v
	default:
		b.shut()
		return fmt.Errorf("the desktop did not open a shortcuts session")
	}
	for _, member := range []string{"Activated", "Deactivated"} {
		if err := conn.AddMatchSignal(dbus.WithMatchObjectPath(portalPath), dbus.WithMatchInterface(portalShortcut), dbus.WithMatchMember(member)); err != nil {
			b.shut()
			return err
		}
	}
	go b.listen(b.signals, b.stop, b.session)
	return nil
}

func (b *portalBackend) listen(signals chan *dbus.Signal, stop chan struct{}, session dbus.ObjectPath) {
	for {
		select {
		case sig := <-signals:
			if sig == nil || len(sig.Body) < 2 || (sig.Name != portalShortcut+".Activated" && sig.Name != portalShortcut+".Deactivated") {
				continue
			}
			if path, _ := sig.Body[0].(dbus.ObjectPath); path != session {
				continue
			}
			if id, _ := sig.Body[1].(string); id != "" {
				b.emit(id, sig.Name == portalShortcut+".Activated")
			}
		case <-stop:
			return
		}
	}
}

func (b *portalBackend) set(entries []entry) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	codes := make([]string, len(entries))
	fail := func(code string) []string {
		for i := range codes {
			codes[i] = code
		}
		return codes
	}
	if len(entries) == 0 {
		return codes
	}
	if err := b.open(); err != nil {
		return fail(ErrWayland)
	}
	type shortcut struct {
		ID      string
		Options map[string]dbus.Variant
	}
	list := make([]shortcut, 0, len(entries))
	for i, e := range entries {
		trigger, ok := portalTrigger(e.combo)
		if !ok {
			codes[i] = ErrInvalid
			continue
		}
		list = append(list, shortcut{e.id, map[string]dbus.Variant{
			"description": dbus.MakeVariant(e.id), "preferred_trigger": dbus.MakeVariant(trigger),
		}})
	}
	if _, err := b.request(portalShortcut+".BindShortcuts", func(handle string) []any {
		return []any{b.session, list, "", map[string]dbus.Variant{"handle_token": dbus.MakeVariant(handle)}}
	}); err != nil {
		for i := range codes {
			if codes[i] == ErrNone {
				codes[i] = ErrUnavailable
			}
		}
	}
	return codes
}

func (b *portalBackend) request(method string, args func(handle string) []any) (map[string]dbus.Variant, error) {
	sender := strings.ReplaceAll(strings.TrimPrefix(b.conn.Names()[0], ":"), ".", "_")
	handle := portalToken()
	path := dbus.ObjectPath("/org/freedesktop/portal/desktop/request/" + sender + "/" + handle)
	opts := []dbus.MatchOption{dbus.WithMatchObjectPath(path), dbus.WithMatchInterface(portalRequest), dbus.WithMatchMember("Response")}
	if err := b.conn.AddMatchSignal(opts...); err != nil {
		return nil, err
	}
	defer b.conn.RemoveMatchSignal(opts...)
	call := b.conn.Object(portalName, portalPath).Call(method, 0, args(handle)...)
	if call.Err != nil {
		return nil, call.Err
	}
	timeout := time.After(portalWait)
	for {
		select {
		case sig := <-b.signals:
			if sig == nil || sig.Path != path || sig.Name != portalRequest+".Response" || len(sig.Body) < 2 {
				continue
			}
			if code, _ := sig.Body[0].(uint32); code != 0 {
				return nil, fmt.Errorf("the desktop refused %s", method)
			}
			results, _ := sig.Body[1].(map[string]dbus.Variant)
			return results, nil
		case <-timeout:
			return nil, fmt.Errorf("the desktop did not answer %s", method)
		}
	}
}

func (b *portalBackend) shut() {
	if b.stop != nil {
		close(b.stop)
		b.stop = nil
	}
	if b.conn != nil {
		if b.session != "" {
			b.conn.Object(portalName, b.session).Call("org.freedesktop.portal.Session.Close", 0)
		}
		_ = b.conn.Close()
		b.conn, b.session = nil, ""
	}
}

func (b *portalBackend) close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.shut()
}

var portalKeys = map[string]string{
	"Space": "space", "Tab": "Tab", "Enter": "Return", "Backspace": "BackSpace", "Delete": "Delete", "Insert": "Insert",
	"Home": "Home", "End": "End", "PageUp": "Page_Up", "PageDown": "Page_Down", "Up": "Up", "Down": "Down", "Left": "Left", "Right": "Right",
	"Scrolllock": "Scroll_Lock", "PrintScreen": "Print", "Capslock": "Caps_Lock", "Numlock": "Num_Lock",
	"-": "minus", "=": "equal", "[": "bracketleft", "]": "bracketright", "\\": "backslash", ";": "semicolon", "'": "apostrophe",
	",": "comma", ".": "period", "/": "slash", "`": "grave",
	"numadd": "KP_Add", "numsub": "KP_Subtract", "nummult": "KP_Multiply", "numdiv": "KP_Divide", "numdec": "KP_Decimal", "numenter": "KP_Enter",
	"MediaPlayPause": "XF86AudioPlay", "MediaNextTrack": "XF86AudioNext", "MediaPreviousTrack": "XF86AudioPrev", "MediaStop": "XF86AudioStop",
	"VolumeMute": "XF86AudioMute", "VolumeUp": "XF86AudioRaiseVolume", "VolumeDown": "XF86AudioLowerVolume",
}

// portalTrigger writes a combo as the shortcuts specification does: "CTRL+ALT+v", the modifiers in capitals and the key as its X keysym name.
func portalTrigger(c Combo) (string, bool) {
	if c.Mouse() > 0 {
		return "", false
	}
	key := portalKeys[c.Key]
	switch {
	case key != "":
	case len(c.Key) == 1 && c.Key[0] >= 'A' && c.Key[0] <= 'Z':
		key = strings.ToLower(c.Key)
	case len(c.Key) == 1 || c.Key[0] == 'F':
		key = c.Key
	case strings.HasPrefix(c.Key, "num"):
		key = "KP_" + c.Key[3:]
	default:
		return "", false
	}
	var parts []string
	if c.Ctrl {
		parts = append(parts, "CTRL")
	}
	if c.Alt {
		parts = append(parts, "ALT")
	}
	if c.Shift {
		parts = append(parts, "SHIFT")
	}
	if c.Meta {
		parts = append(parts, "LOGO")
	}
	return strings.Join(append(parts, key), "+"), true
}
