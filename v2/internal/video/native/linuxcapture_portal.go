//go:build linux

package native

// The screen cast portal (org.freedesktop.portal.ScreenCast) over D-Bus: the desktop asks the user which screen to share, and
// hands back a PipeWire connection and the node that carries the screen. This is the only way to capture a Wayland desktop.

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/godbus/dbus/v5"
)

const (
	portalName                 = "org.freedesktop.portal.Desktop"
	portalPath                 = "/org/freedesktop/portal/desktop"
	portalScreenCast           = "org.freedesktop.portal.ScreenCast"
	portalRequest              = "org.freedesktop.portal.Request"
	portalSession              = "org.freedesktop.portal.Session"
	portalAnswerWait           = 3 * time.Minute
	portalSourceScreenOrWindow = 1 | 2
	portalCursorEmbedded       = 2
)

type portalCast struct {
	conn    *dbus.Conn
	signals chan *dbus.Signal
	session dbus.ObjectPath
	node    uint32
	fd      int
	closed  chan struct{}
}

func portalToken() string {
	var b [8]byte
	rand.Read(b[:])
	return "harmony" + hex.EncodeToString(b[:])
}

// openPortalCast asks for a screen. It returns when the user has chosen one, or has refused.
func openPortalCast(display int) (*portalCast, error) {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, fmt.Errorf("the desktop's message bus is not reachable (%v): screen sharing needs a desktop session with xdg-desktop-portal", err)
	}
	p := &portalCast{conn: conn, signals: make(chan *dbus.Signal, 64), closed: make(chan struct{})}
	conn.Signal(p.signals)
	fail := func(err error) (*portalCast, error) {
		p.Close()
		return nil, err
	}
	obj := conn.Object(portalName, portalPath)
	if v, err := obj.GetProperty(portalScreenCast + ".version"); err != nil || v.Value() == nil {
		return fail(errors.New("screen sharing needs xdg-desktop-portal and a portal backend for your desktop (xdg-desktop-portal-gnome, -kde, -wlr or -hyprland)"))
	}

	token := portalToken()
	res, err := p.request(portalScreenCast+".CreateSession", func(handle string) []any {
		return []any{map[string]dbus.Variant{"handle_token": dbus.MakeVariant(handle), "session_handle_token": dbus.MakeVariant(token)}}
	})
	if err != nil {
		return fail(err)
	}
	switch v := res["session_handle"].Value().(type) {
	case string:
		p.session = dbus.ObjectPath(v)
	case dbus.ObjectPath:
		p.session = v
	default:
		return fail(errors.New("the screen cast portal did not open a session"))
	}
	if err := conn.AddMatchSignal(dbus.WithMatchObjectPath(p.session), dbus.WithMatchInterface(portalSession), dbus.WithMatchMember("Closed")); err != nil {
		return fail(err)
	}

	cursor := uint32(portalCursorEmbedded)
	if v, err := obj.GetProperty(portalScreenCast + ".AvailableCursorModes"); err == nil {
		if modes, ok := v.Value().(uint32); ok && modes&portalCursorEmbedded == 0 {
			cursor = 1
		}
	}
	if _, err := p.request(portalScreenCast+".SelectSources", func(handle string) []any {
		return []any{p.session, map[string]dbus.Variant{
			"handle_token": dbus.MakeVariant(handle), "types": dbus.MakeVariant(uint32(portalSourceScreenOrWindow)),
			"multiple": dbus.MakeVariant(false), "cursor_mode": dbus.MakeVariant(cursor)}}
	}); err != nil {
		return fail(err)
	}
	res, err = p.request(portalScreenCast+".Start", func(handle string) []any {
		return []any{p.session, "", map[string]dbus.Variant{"handle_token": dbus.MakeVariant(handle)}}
	})
	if err != nil {
		return fail(err)
	}
	streams, _ := res["streams"].Value().([][]any)
	if len(streams) == 0 {
		return fail(errors.New("the screen cast portal sent no screen"))
	}
	node, ok := streams[min(display, len(streams)-1)][0].(uint32)
	if !ok {
		return fail(errors.New("the screen cast portal sent a stream this client cannot read"))
	}
	p.node = node

	var fd dbus.UnixFD
	call := obj.Call(portalScreenCast+".OpenPipeWireRemote", 0, p.session, map[string]dbus.Variant{})
	if call.Err != nil || len(call.Body) == 0 || call.Store(&fd) != nil {
		return fail(fmt.Errorf("the screen cast portal did not hand over the PipeWire connection: %v", call.Err))
	}
	p.fd = int(fd)
	return p, nil
}

// request makes a portal call that answers with a Response signal on a request object, and waits for the answer: the user
// may take a while to choose.
func (p *portalCast) request(method string, args func(handle string) []any) (map[string]dbus.Variant, error) {
	sender := strings.ReplaceAll(strings.TrimPrefix(p.conn.Names()[0], ":"), ".", "_")
	handle := portalToken()
	path := dbus.ObjectPath("/org/freedesktop/portal/desktop/request/" + sender + "/" + handle)
	opts := []dbus.MatchOption{dbus.WithMatchObjectPath(path), dbus.WithMatchInterface(portalRequest), dbus.WithMatchMember("Response")}
	if err := p.conn.AddMatchSignal(opts...); err != nil {
		return nil, err
	}
	defer p.conn.RemoveMatchSignal(opts...)
	call := p.conn.Object(portalName, portalPath).Call(method, 0, args(handle)...)
	if call.Err != nil {
		return nil, fmt.Errorf("the screen cast portal refused %s: %w", method[strings.LastIndexByte(method, '.')+1:], call.Err)
	}
	if got, ok := call.Body[0].(dbus.ObjectPath); ok && got != path {
		// Portals older than 0.9 answer on a path of their own.
		path = got
		p.conn.AddMatchSignal(dbus.WithMatchObjectPath(path), dbus.WithMatchInterface(portalRequest), dbus.WithMatchMember("Response"))
	}
	timeout := time.After(portalAnswerWait)
	for {
		select {
		case sig := <-p.signals:
			if sig.Path != path || sig.Name != portalRequest+".Response" || len(sig.Body) < 2 {
				continue
			}
			code, _ := sig.Body[0].(uint32)
			results, _ := sig.Body[1].(map[string]dbus.Variant)
			switch code {
			case 0:
				return results, nil
			case 1:
				return nil, errors.New("the screen share was cancelled")
			}
			return nil, errors.New("the desktop could not share the screen")
		case <-timeout:
			return nil, errors.New("the screen share was not confirmed in time")
		}
	}
}

// watch calls onClosed once when the desktop ends the share (the user pressed its stop button).
func (p *portalCast) watch(onClosed func()) {
	go func() {
		for {
			select {
			case sig := <-p.signals:
				if sig.Path == p.session && sig.Name == portalSession+".Closed" {
					onClosed()
					return
				}
			case <-p.closed:
				return
			}
		}
	}()
}

func (p *portalCast) Close() {
	select {
	case <-p.closed:
		return
	default:
	}
	close(p.closed)
	if p.session != "" {
		p.conn.Object(portalName, p.session).Call(portalSession+".Close", 0)
	}
	p.conn.Close()
}
