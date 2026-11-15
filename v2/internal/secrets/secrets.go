// Package secrets keeps small secrets (a password, a session token) in the operating system's own store: the Keychain
// on macOS, the Windows data protection API, the Secret Service on Linux. Nothing here uses cgo.
package secrets

import "errors"

// ErrNotFound is what Get says when nothing is kept under the key.
var ErrNotFound = errors.New("no such secret")

// service names the items in the system's store, so they are told from other programs'.
const service = "Harmony v2"
