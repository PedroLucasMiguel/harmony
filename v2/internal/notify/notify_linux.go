package notify

import (
	"sync"

	"github.com/godbus/dbus/v5"
)

// org.freedesktop.Notifications: Notify returns an id, and ActionInvoked says when its "default" action (a click) was used.
const clickable = true

const (
	service   = "org.freedesktop.Notifications"
	path      = "/org/freedesktop/Notifications"
	iface     = "org.freedesktop.Notifications"
	appName   = "Harmony"
	timeoutMS = 8000
)

var bus struct {
	mu      sync.Mutex
	conn    *dbus.Conn
	clicks  map[uint32]func()
	started bool
}

func connect() (*dbus.Conn, error) {
	bus.mu.Lock()
	defer bus.mu.Unlock()
	if bus.conn != nil {
		return bus.conn, nil
	}
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, err
	}
	if err := conn.AddMatchSignal(dbus.WithMatchInterface(iface), dbus.WithMatchMember("ActionInvoked")); err != nil {
		_ = conn.Close()
		return nil, err
	}
	bus.conn, bus.clicks = conn, map[uint32]func(){}
	signals := make(chan *dbus.Signal, 16)
	conn.Signal(signals)
	go func() {
		for sig := range signals {
			if sig.Name != iface+".ActionInvoked" || len(sig.Body) < 2 {
				continue
			}
			id, _ := sig.Body[0].(uint32)
			bus.mu.Lock()
			click := bus.clicks[id]
			delete(bus.clicks, id)
			bus.mu.Unlock()
			if click != nil {
				click()
			}
		}
	}()
	return conn, nil
}

// Show puts the notification on screen.
func Show(n Notification) error {
	conn, err := connect()
	if err != nil {
		return err
	}
	var actions []string
	if n.OnClick != nil {
		actions = []string{"default", "Open"}
	}
	hints := map[string]dbus.Variant{"desktop-entry": dbus.MakeVariant("harmony")}
	call := conn.Object(service, path).Call(iface+".Notify", 0, appName, uint32(0), "", n.Title, n.Body, actions, hints, int32(timeoutMS))
	if call.Err != nil {
		return call.Err
	}
	var id uint32
	if n.OnClick != nil && call.Store(&id) == nil {
		bus.mu.Lock()
		bus.clicks[id] = n.OnClick
		bus.mu.Unlock()
	}
	return nil
}
