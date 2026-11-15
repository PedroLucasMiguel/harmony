package tray

import (
	"bytes"
	"fmt"
	"image"
	"image/png"
	"os"
	"sync"

	"github.com/godbus/dbus/v5"
	"github.com/godbus/dbus/v5/introspect"
	"github.com/godbus/dbus/v5/prop"
)

// A StatusNotifierItem: the freedesktop tray protocol that KDE, XFCE and most desktops' panels read, and GNOME reads with
// its AppIndicator extension. The menu travels as a com.canonical.dbusmenu object the panel draws itself.

const (
	sniPath     = "/StatusNotifierItem"
	menuPath    = "/MenuBar"
	sniIface    = "org.kde.StatusNotifierItem"
	menuIface   = "com.canonical.dbusmenu"
	watcherName = "org.kde.StatusNotifierWatcher"
	watcherPath = "/StatusNotifierWatcher"
	iconPixels  = 32
)

type pixmap struct {
	W, H int32
	Data []byte
}

type menuLayout struct {
	ID       int32
	Props    map[string]dbus.Variant
	Children []dbus.Variant
}

type menuProps struct {
	ID    int32
	Props map[string]dbus.Variant
}

type linuxTray struct {
	opt  Options
	conn *dbus.Conn
	name string
	prop *prop.Properties

	mu       sync.Mutex
	items    []Item
	revision uint32
	badge    int
	tip      string
}

func start(opt Options) impl {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil
	}
	if v, err := conn.Object(watcherName, watcherPath).GetProperty(watcherName + ".IsStatusNotifierHostRegistered"); err != nil || v.Value() != true {
		_ = conn.Close()
		return nil
	}
	t := &linuxTray{opt: opt, conn: conn, name: fmt.Sprintf("org.kde.StatusNotifierItem-%d-1", os.Getpid()), tip: opt.Tooltip}
	if _, err := conn.RequestName(t.name, dbus.NameFlagDoNotQueue); err != nil {
		_ = conn.Close()
		return nil
	}
	if opt.Menu != nil {
		t.items = opt.Menu()
	}
	if t.export() != nil {
		_ = conn.Close()
		return nil
	}
	if call := conn.Object(watcherName, watcherPath).Call(watcherName+".RegisterStatusNotifierItem", 0, t.name); call.Err != nil {
		_ = conn.Close()
		return nil
	}
	return t
}

func (t *linuxTray) export() error {
	if err := t.conn.Export(itemMethods{t}, sniPath, sniIface); err != nil {
		return err
	}
	if err := t.conn.Export(menuMethods{t}, menuPath, menuIface); err != nil {
		return err
	}
	props := map[string]map[string]*prop.Prop{
		sniIface: {
			"Category":   {Value: "ApplicationStatus"},
			"Id":         {Value: "harmony"},
			"Title":      {Value: "Harmony"},
			"Status":     {Value: "Active"},
			"IconName":   {Value: ""},
			"IconPixmap": {Value: []pixmap{t.pixmap(t.opt.Icon)}, Writable: false, Emit: prop.EmitTrue},
			"ToolTip":    {Value: tooltip{Title: t.tip}, Emit: prop.EmitTrue},
			"ItemIsMenu": {Value: false},
			"Menu":       {Value: dbus.ObjectPath(menuPath)},
		},
		menuIface: {
			"Version":       {Value: uint32(3)},
			"TextDirection": {Value: "ltr"},
			"Status":        {Value: "normal"},
			"IconThemePath": {Value: []string{}},
		},
	}
	var err error
	if t.prop, err = prop.Export(t.conn, sniPath, props); err != nil {
		return err
	}
	node := &introspect.Node{Name: sniPath, Interfaces: []introspect.Interface{
		introspect.IntrospectData,
		prop.IntrospectData,
		{Name: sniIface, Methods: introspect.Methods(itemMethods{t}), Properties: t.prop.Introspection(sniIface)},
	}}
	if err := t.conn.Export(introspect.NewIntrospectable(node), sniPath, "org.freedesktop.DBus.Introspectable"); err != nil {
		return err
	}
	menuNode := &introspect.Node{Name: menuPath, Interfaces: []introspect.Interface{
		introspect.IntrospectData,
		{Name: menuIface, Methods: introspect.Methods(menuMethods{t})},
	}}
	return t.conn.Export(introspect.NewIntrospectable(menuNode), menuPath, "org.freedesktop.DBus.Introspectable")
}

type tooltip struct {
	Icon  string
	Pixs  []pixmap
	Title string
	Text  string
}

func (t *linuxTray) pixmap(data []byte) pixmap {
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return pixmap{}
	}
	rgba := image.NewNRGBA(img.Bounds())
	for y := rgba.Bounds().Min.Y; y < rgba.Bounds().Max.Y; y++ {
		for x := rgba.Bounds().Min.X; x < rgba.Bounds().Max.X; x++ {
			rgba.Set(x, y, img.At(x, y))
		}
	}
	b := rgba.Bounds()
	out := make([]byte, 0, b.Dx()*b.Dy()*4)
	for i := 0; i < len(rgba.Pix); i += 4 {
		out = append(out, rgba.Pix[i+3], rgba.Pix[i], rgba.Pix[i+1], rgba.Pix[i+2])
	}
	return pixmap{int32(b.Dx()), int32(b.Dy()), out}
}

type itemMethods struct{ t *linuxTray }

func (m itemMethods) Activate(x, y int32) *dbus.Error {
	if m.t.opt.OnOpen != nil {
		go m.t.opt.OnOpen()
	}
	return nil
}
func (m itemMethods) SecondaryActivate(x, y int32) *dbus.Error { return nil }
func (m itemMethods) ContextMenu(x, y int32) *dbus.Error       { return nil }
func (m itemMethods) Scroll(delta int32, orientation string) *dbus.Error {
	return nil
}

type menuMethods struct{ t *linuxTray }

func (m menuMethods) layout() menuLayout {
	m.t.mu.Lock()
	defer m.t.mu.Unlock()
	root := menuLayout{Props: map[string]dbus.Variant{"children-display": dbus.MakeVariant("submenu")}}
	for i, it := range m.t.items {
		props := map[string]dbus.Variant{"label": dbus.MakeVariant(it.Label), "enabled": dbus.MakeVariant(!it.Disabled)}
		if it.Separator {
			props = map[string]dbus.Variant{"type": dbus.MakeVariant("separator")}
		}
		if it.Checked {
			props["toggle-type"], props["toggle-state"] = dbus.MakeVariant("checkmark"), dbus.MakeVariant(int32(1))
		}
		root.Children = append(root.Children, dbus.MakeVariant(menuLayout{ID: int32(i + 1), Props: props, Children: []dbus.Variant{}}))
	}
	return root
}

func (m menuMethods) GetLayout(parent, depth int32, names []string) (uint32, menuLayout, *dbus.Error) {
	if m.t.opt.Menu != nil {
		m.t.mu.Lock()
		m.t.items = m.t.opt.Menu()
		m.t.mu.Unlock()
	}
	return m.t.revision, m.layout(), nil
}

func (m menuMethods) GetGroupProperties(ids []int32, names []string) ([]menuProps, *dbus.Error) {
	return nil, nil
}

func (m menuMethods) GetProperty(id int32, name string) (dbus.Variant, *dbus.Error) {
	return dbus.MakeVariant(""), nil
}

func (m menuMethods) Event(id int32, event string, data dbus.Variant, timestamp uint32) *dbus.Error {
	if event != "clicked" {
		return nil
	}
	m.t.mu.Lock()
	var click func()
	if i := int(id) - 1; i >= 0 && i < len(m.t.items) {
		click = m.t.items[i].OnClick
	}
	m.t.mu.Unlock()
	if click != nil {
		go click()
	}
	return nil
}

func (m menuMethods) AboutToShow(id int32) (bool, *dbus.Error) { return true, nil }

func (t *linuxTray) setIcon(data []byte) {
	if len(data) > 0 {
		t.prop.SetMust(sniIface, "IconPixmap", []pixmap{t.pixmap(data)})
		_ = t.conn.Emit(sniPath, sniIface+".NewIcon")
	}
}

func (t *linuxTray) setTooltip(text string) {
	t.mu.Lock()
	t.tip = text
	badge := t.badge
	t.mu.Unlock()
	t.showTooltip(text, badge)
}

func (t *linuxTray) showTooltip(text string, badge int) {
	title := text
	if badge > 0 {
		title += fmt.Sprintf(" (%d)", badge)
	}
	t.prop.SetMust(sniIface, "ToolTip", tooltip{Title: title})
	_ = t.conn.Emit(sniPath, sniIface+".NewToolTip")
}

func (t *linuxTray) setBadge(count int) {
	t.mu.Lock()
	changed := t.badge != count
	t.badge = count
	tip := t.tip
	t.mu.Unlock()
	if changed {
		t.showTooltip(tip, count)
	}
}

func (t *linuxTray) setMenu(items []Item) {
	t.mu.Lock()
	t.items = items
	t.revision++
	rev := t.revision
	t.mu.Unlock()
	_ = t.conn.Emit(menuPath, menuIface+".LayoutUpdated", rev, int32(0))
}

func (t *linuxTray) balloon(string, string, func()) {}

func (t *linuxTray) close() { _ = t.conn.Close() }
