//go:build linux

package secrets

import (
	"context"
	"errors"
	"time"

	"github.com/godbus/dbus/v5"
)

// On Linux the Secret Service (GNOME Keyring, KWallet) keeps the values. Where there is none, or it will not answer, a
// file in the settings directory that only this user can read does.

const (
	serviceName    = "org.freedesktop.secrets"
	servicePath    = "/org/freedesktop/secrets"
	serviceFace    = "org.freedesktop.Secret.Service"
	collectionFace = "org.freedesktop.Secret.Collection"
	itemFace       = "org.freedesktop.Secret.Item"
	promptFace     = "org.freedesktop.Secret.Prompt"
	noObject       = dbus.ObjectPath("/")
	askTimeout     = 90 * time.Second
)

var file = &fileStore{
	seal: func(b []byte) ([]byte, error) { return b, nil },
	open: func(b []byte) ([]byte, error) { return b, nil },
}

// secret is the Secret Service's structure for a value: session, parameters, value, content type.
type secret struct {
	Session     dbus.ObjectPath
	Parameters  []byte
	Value       []byte
	ContentType string
}

// vault is one connection to the Secret Service with a session that sends values as they are, which is safe on the
// session bus of one person.
type vault struct {
	conn    *dbus.Conn
	service dbus.BusObject
	session dbus.ObjectPath
}

func openVault() (*vault, error) {
	conn, err := dbus.SessionBus()
	if err != nil {
		return nil, err
	}
	v := &vault{conn: conn, service: conn.Object(serviceName, servicePath)}
	var output dbus.Variant
	if err := v.service.Call(serviceFace+".OpenSession", 0, "plain", dbus.MakeVariant("")).Store(&output, &v.session); err != nil {
		return nil, err
	}
	return v, nil
}

func (v *vault) close() {
	v.conn.Object(serviceName, v.session).Call("org.freedesktop.Secret.Session.Close", 0)
}

func attributes(key string) map[string]string {
	return map[string]string{"service": service, "key": key}
}

// wait lets the person answer a prompt the service raised, and says whether they accepted it.
func (v *vault) wait(prompt dbus.ObjectPath) error {
	if prompt == noObject {
		return nil
	}
	signals := make(chan *dbus.Signal, 4)
	v.conn.Signal(signals)
	defer v.conn.RemoveSignal(signals)
	if err := v.conn.AddMatchSignal(dbus.WithMatchObjectPath(prompt), dbus.WithMatchInterface(promptFace)); err != nil {
		return err
	}
	if err := v.conn.Object(serviceName, prompt).Call(promptFace+".Prompt", 0, "").Err; err != nil {
		return err
	}
	timeout := time.After(askTimeout)
	for {
		select {
		case sig := <-signals:
			if sig.Path == prompt && sig.Name == promptFace+".Completed" {
				if len(sig.Body) > 0 {
					if dismissed, _ := sig.Body[0].(bool); dismissed {
						return errors.New("the keyring was not unlocked")
					}
				}
				return nil
			}
		case <-timeout:
			return errors.New("the keyring was not unlocked in time")
		}
	}
}

func (v *vault) unlock(objects ...dbus.ObjectPath) error {
	var unlocked []dbus.ObjectPath
	var prompt dbus.ObjectPath
	if err := v.service.Call(serviceFace+".Unlock", 0, objects).Store(&unlocked, &prompt); err != nil {
		return err
	}
	return v.wait(prompt)
}

// find is where the value is kept, or ErrNotFound.
func (v *vault) find(key string) (dbus.ObjectPath, error) {
	var unlocked, locked []dbus.ObjectPath
	if err := v.service.Call(serviceFace+".SearchItems", 0, attributes(key)).Store(&unlocked, &locked); err != nil {
		return "", err
	}
	if len(unlocked) > 0 {
		return unlocked[0], nil
	}
	if len(locked) == 0 {
		return "", ErrNotFound
	}
	if err := v.unlock(locked[0]); err != nil {
		return "", err
	}
	return locked[0], nil
}

func (v *vault) get(key string) ([]byte, error) {
	path, err := v.find(key)
	if err != nil {
		return nil, err
	}
	var s secret
	if err := v.conn.Object(serviceName, path).Call(itemFace+".GetSecret", 0, v.session).Store(&s); err != nil {
		return nil, err
	}
	return s.Value, nil
}

func (v *vault) set(key string, value []byte) error {
	var collection dbus.ObjectPath
	if err := v.service.Call(serviceFace+".ReadAlias", 0, "default").Store(&collection); err != nil {
		return err
	}
	if collection == noObject {
		return errors.New("there is no default keyring")
	}
	if err := v.unlock(collection); err != nil {
		return err
	}
	properties := map[string]dbus.Variant{
		itemFace + ".Label":      dbus.MakeVariant(service + ": " + key),
		itemFace + ".Attributes": dbus.MakeVariant(attributes(key)),
	}
	var item, prompt dbus.ObjectPath
	call := v.conn.Object(serviceName, collection).Call(collectionFace+".CreateItem", 0, properties, secret{Session: v.session, Value: value, ContentType: "text/plain"}, true)
	if err := call.Store(&item, &prompt); err != nil {
		return err
	}
	return v.wait(prompt)
}

func (v *vault) remove(key string) error {
	path, err := v.find(key)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	var prompt dbus.ObjectPath
	if err := v.conn.Object(serviceName, path).Call(itemFace+".Delete", 0).Store(&prompt); err != nil {
		return err
	}
	return v.wait(prompt)
}

// withVault runs fn on a connection to the Secret Service, giving up when it does not answer.
func withVault(fn func(v *vault) error) error {
	done := make(chan error, 1)
	go func() {
		v, err := openVault()
		if err != nil {
			done <- err
			return
		}
		defer v.close()
		done <- fn(v)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*askTimeout)
	defer cancel()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Get is what is kept under the key.
func Get(key string) ([]byte, error) {
	var out []byte
	err := withVault(func(v *vault) (err error) { out, err = v.get(key); return })
	if err == nil {
		return out, nil
	}
	if fromFile, ferr := file.get(key); ferr == nil {
		return fromFile, nil
	}
	return nil, err
}

// Set keeps the value under the key, replacing what was there.
func Set(key string, value []byte) error {
	if err := withVault(func(v *vault) error { return v.set(key, value) }); err != nil {
		return file.set(key, value)
	}
	_ = file.remove(key)
	return nil
}

// Delete forgets the key; a key that is not there is not an error.
func Delete(key string) error {
	err := withVault(func(v *vault) error { return v.remove(key) })
	if ferr := file.remove(key); ferr != nil && err != nil {
		return ferr
	}
	return nil
}
