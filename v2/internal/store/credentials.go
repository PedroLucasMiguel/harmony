package store

import (
	"encoding/json"
	"errors"
	"strings"

	"harmony/v2/internal/secrets"
)

// Credentials are what is kept of signing in to one server, in the system's secret store and not in the settings file.
type Credentials struct {
	// Token is the session, to go straight in at the next start.
	Token string `json:"token,omitempty"`
	// Password is the account's own, kept while "Remember me" is on, to sign in again when the session has expired.
	Password string `json:"password,omitempty"`
	// Door is the password the server itself asks for before anything.
	Door string `json:"door,omitempty"`
}

func (c Credentials) empty() bool { return c == Credentials{} }

func credentialsKey(server string) string {
	return "server:" + strings.ToLower(strings.TrimRight(strings.TrimSpace(server), "/"))
}

// LoadCredentials is what is kept for the server, or nothing.
func LoadCredentials(server string) Credentials {
	var c Credentials
	if raw, err := secrets.Get(credentialsKey(server)); err == nil {
		_ = json.Unmarshal(raw, &c)
	}
	return c
}

// SaveCredentials keeps them for the server; nothing at all removes the item.
func SaveCredentials(server string, c Credentials) error {
	if c.empty() {
		return ForgetCredentials(server)
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return secrets.Set(credentialsKey(server), raw)
}

// UpdateCredentials changes what is kept for the server.
func UpdateCredentials(server string, change func(*Credentials)) error {
	c := LoadCredentials(server)
	change(&c)
	return SaveCredentials(server, c)
}

// ForgetCredentials removes everything kept for the server.
func ForgetCredentials(server string) error {
	err := secrets.Delete(credentialsKey(server))
	if errors.Is(err, secrets.ErrNotFound) {
		return nil
	}
	return err
}
