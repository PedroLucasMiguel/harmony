package dm

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// keyFile is what this computer keeps of your private conversations on one server, for one account: the identity key
// and its id on the server (and the ones before it, so what was sealed to them still opens), the recovery key until
// the person says it is somewhere safe, the key each person had the first time you talked to them, the ones accepted
// since, and the key whose safety number was compared in person. The layout is the Electron client's `dmKeys` record,
// with the secrets in the clear in a file only this user can read.
//
// It is not safe for concurrent use: the vault's lock is the one that guards it.
type keyFile struct {
	path string

	keyID         int
	identity      *Identity
	archive       map[int]*Identity
	recovery      *recoveryKey
	recoverySaved bool
	pins          map[int]string
	accepted      map[int][]string
	verified      map[int]string

	writeErr error
}

type keyRecord struct {
	KeyID         int                 `json:"keyId"`
	Secret        string              `json:"secret"`
	Recovery      string              `json:"recovery"`
	RecoverySaved bool                `json:"recoverySaved"`
	Archive       map[string]string   `json:"archive"`
	Pins          map[string]string   `json:"pins"`
	Accepted      map[string][]string `json:"accepted"`
	Verified      map[string]string   `json:"verified"`
}

func newKeyFile() *keyFile {
	return &keyFile{archive: map[int]*Identity{}, pins: map[int]string{}, accepted: map[int][]string{}, verified: map[int]string{}}
}

// KeyPath is where this account's keys on this server are kept, or "" when there is no place to keep them.
func KeyPath(server string, userID int) string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "Harmony v2", "dm", hex.EncodeToString(sha256Of(strings.ToLower(strings.TrimRight(strings.TrimSpace(server), "/")) + "#" + strconv.Itoa(userID))[:8])+".json")
}

// openKeyFile reads the file at path; a path that does not exist yet is an empty file that will be written there.
func openKeyFile(path string) (*keyFile, error) {
	k := newKeyFile()
	k.path = path
	if path == "" {
		return k, nil
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return k, nil
	}
	if err != nil {
		return nil, err
	}
	var rec keyRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		return nil, err
	}
	k.restore(rec)
	return k, nil
}

func parseSecret(h string) *Identity {
	raw, err := hex.DecodeString(h)
	if err != nil {
		return nil
	}
	id, err := identityFromSecret(raw)
	if err != nil {
		return nil
	}
	return id
}

func (k *keyFile) restore(rec keyRecord) {
	k.keyID = rec.KeyID
	if k.keyID != 0 {
		k.identity = parseSecret(rec.Secret)
	}
	if r, ok := parseRecoveryKey(rec.Recovery); ok && rec.Recovery != "" {
		k.recovery = &r
	}
	k.recoverySaved = rec.RecoverySaved
	for id, h := range rec.Archive {
		if n, err := strconv.Atoi(id); err == nil {
			if identity := parseSecret(h); identity != nil {
				k.archive[n] = identity
			}
		}
	}
	for user, key := range rec.Pins {
		if n, err := strconv.Atoi(user); err == nil {
			k.pins[n] = key
		}
	}
	for user, keys := range rec.Accepted {
		if n, err := strconv.Atoi(user); err == nil {
			k.accepted[n] = slices.Clone(keys)
		}
	}
	for user, key := range rec.Verified {
		if n, err := strconv.Atoi(user); err == nil {
			k.verified[n] = key
		}
	}
}

func (k *keyFile) record() keyRecord {
	rec := keyRecord{
		KeyID: k.keyID, RecoverySaved: k.recoverySaved,
		Archive: map[string]string{}, Pins: map[string]string{}, Accepted: map[string][]string{}, Verified: map[string]string{},
	}
	if k.identity != nil {
		rec.Secret = hex.EncodeToString(k.identity.secret[:])
	}
	if k.recovery != nil {
		rec.Recovery = k.recovery.display()
	}
	for id, identity := range k.archive {
		rec.Archive[strconv.Itoa(id)] = hex.EncodeToString(identity.secret[:])
	}
	for user, key := range k.pins {
		rec.Pins[strconv.Itoa(user)] = key
	}
	for user, keys := range k.accepted {
		rec.Accepted[strconv.Itoa(user)] = keys
	}
	for user, key := range k.verified {
		rec.Verified[strconv.Itoa(user)] = key
	}
	return rec
}

// changed writes the file at once, atomically: a key the server already has the public half of, lost here, is lost
// for good. A failure is kept for flush to report.
func (k *keyFile) changed() {
	if k.path == "" {
		return
	}
	data, err := json.MarshalIndent(k.record(), "", "  ")
	if err == nil {
		err = os.MkdirAll(filepath.Dir(k.path), 0o700)
	}
	if err == nil {
		tmp := k.path + ".tmp"
		if err = os.WriteFile(tmp, data, 0o600); err == nil {
			err = os.Rename(tmp, k.path)
		}
	}
	k.writeErr = err
}

// flush says whether the last write reached the disk.
func (k *keyFile) flush() error {
	err := k.writeErr
	k.writeErr = nil
	return err
}

func (k *keyFile) current() (int, *Identity) {
	if k.keyID != 0 && k.identity != nil {
		return k.keyID, k.identity
	}
	return 0, nil
}

func (k *keyFile) archiveCurrent() {
	if k.keyID != 0 && k.identity != nil {
		k.archive[k.keyID] = k.identity
	}
}

// setIdentity makes this the account's key from now on; the one it replaces is archived, not dropped.
func (k *keyFile) setIdentity(keyID int, identity *Identity) {
	if k.keyID != keyID {
		k.archiveCurrent()
	}
	k.keyID, k.identity = keyID, identity
	k.changed()
}

// retireIdentity stops using the identity key here, as when the server says this account has none. It is archived: the
// server may have lost it, but what was sealed to it is still somewhere, and only this key opens it.
func (k *keyFile) retireIdentity() {
	k.archiveCurrent()
	k.keyID, k.identity, k.recovery, k.recoverySaved = 0, nil, nil, false
	k.changed()
}

// setRecovery stores a recovery key the server now holds a wrapping for. One already kept somewhere (typed in to unlock
// this computer) is not written down here; a new one is, since it is the only way to the wrapping until it is copied.
func (k *keyFile) setRecovery(r recoveryKey, saved bool) {
	k.recovery = nil
	if !saved {
		k.recovery = &r
	}
	k.recoverySaved = saved
	k.changed()
}

func (k *keyFile) isRecoverySaved() bool { return k.recoverySaved || k.recovery == nil }

func (k *keyFile) markRecoverySaved() {
	k.recoverySaved, k.recovery = true, nil
	k.changed()
}

// setPin makes this the key to compare the person's against from now on; the one it replaces stays accepted.
func (k *keyFile) setPin(user int, key string) {
	old, had := k.pins[user]
	k.pins[user] = key
	if had && old == key {
		return
	}
	if had {
		k.accept(user, []string{old})
	}
	k.changed()
}

func (k *keyFile) isAccepted(user int, key string) bool {
	return k.pins[user] == key && k.hasPin(user) || slices.Contains(k.accepted[user], key)
}

func (k *keyFile) hasPin(user int) bool {
	_, ok := k.pins[user]
	return ok
}

func (k *keyFile) accept(user int, keys []string) {
	var fresh []string
	for _, key := range keys {
		if !k.isAccepted(user, key) && !slices.Contains(fresh, key) {
			fresh = append(fresh, key)
		}
	}
	if len(fresh) == 0 {
		return
	}
	k.accepted[user] = append(k.accepted[user], fresh...)
	k.changed()
}

func (k *keyFile) setVerified(user int, key string) {
	if key != "" {
		k.verified[user] = key
	} else {
		delete(k.verified, user)
	}
	k.changed()
}
