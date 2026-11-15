package dm

import (
	"context"
	"encoding/json"
)

// Start asks the server what keys there are and says whether this computer can take part: Ready, Locked (the account has
// a key this computer does not: Unlock or StartOver), Failed or Unsupported. An account with no key gets one made and
// published here; its recovery key is then shown by RecoveryKey until MarkBackedUp. Blocks; call it again to retry.
func (s *Session) Start(ctx context.Context) Status {
	s.mu.Lock()
	s.started = true
	s.mu.Unlock()
	status, raw, err := s.request(ctx, "GET", "/api/keys", nil)
	switch {
	case err != nil:
		s.fail(err.Error())
	case status == 404:
		s.mutate(func() { s.v.state = Unsupported })
	case status != 200:
		s.fail(refusal(status, raw).Message)
	default:
		s.onKeys(ctx, raw)
	}
	return s.Status()
}

func (s *Session) fail(why string) {
	s.mutate(func() { s.v.state, s.v.failure = Failed, why })
}

func (s *Session) onKeys(ctx context.Context, raw []byte) {
	var body struct {
		Keys []Key           `json:"keys"`
		Mine json.RawMessage `json:"mine"`
	}
	if json.Unmarshal(raw, &body) != nil {
		s.fail("The server's answer about keys was not understood.")
		return
	}
	var mine *ownKey
	none := string(body.Mine) == "null"
	if len(body.Mine) > 0 && !none {
		var k ownKey
		if json.Unmarshal(body.Mine, &k) == nil {
			mine = &k
		}
	}
	var create bool
	s.mutate(func() { create = s.v.onKeys(body.Keys, mine, none) })
	if create {
		s.createIdentity(ctx)
	}
	if s.Status().State == Ready {
		_ = s.Refresh(ctx)
	} else {
		s.peekUnread(ctx)
	}
}

// createIdentity makes this account's identity key and publishes it.
func (s *Session) createIdentity(ctx context.Context) {
	identity, recovery, wrapped := newIdentity()
	var out struct {
		Key ownKey `json:"key"`
	}
	err := s.call(ctx, "POST", "/api/keys", map[string]string{"publicKey": identity.publicB64(), "wrapped": wrapped}, 201, &out)
	if err != nil {
		s.fail(err.Error())
		return
	}
	s.adopt(&out.Key, identity, recovery, false)
}

func (s *Session) adopt(key *ownKey, identity *Identity, recovery recoveryKey, saved bool) {
	s.mutate(func() {
		if err := s.v.adopt(key, identity, recovery, saved); err != nil {
			s.v.failure = "The key could not be saved on this computer: " + err.Error()
		}
	})
}

// peekUnread counts the messages waiting in a server this computer cannot open yet; the count is not secret, so a badge
// can say there is something to unlock for.
func (s *Session) peekUnread(ctx context.Context) {
	var out struct {
		Conversations []struct {
			Unread int `json:"unread"`
		} `json:"conversations"`
	}
	if s.call(ctx, "GET", "/api/dms", nil, 200, &out) != nil {
		return
	}
	n := 0
	for _, c := range out.Conversations {
		n += c.Unread
	}
	s.mutate(func() { s.lockedUnread = n })
}

// Unlock opens the account's key with the recovery key as typed (any case, dashes and spaces optional); false if it is
// not the right one.
func (s *Session) Unlock(ctx context.Context, typed string) (bool, error) {
	var ok bool
	var err error
	s.mutate(func() { ok, err = s.v.unlock(typed) })
	if ok {
		_ = s.Refresh(ctx)
	}
	return ok, err
}

// StartOver makes a new identity key when the recovery key is lost and no computer has the key. The old key is archived
// here, so what was sealed to it still opens on this computer and nowhere else.
func (s *Session) StartOver(ctx context.Context) Status {
	s.mutate(func() { s.v.onKeys(nil, nil, true) })
	s.createIdentity(ctx)
	if s.Status().State == Ready {
		_ = s.Refresh(ctx)
	}
	return s.Status()
}

// RecoveryKey is the recovery key as shown ("XXXX-" eight groups), while this computer keeps it: from when it is made
// until MarkBackedUp. Empty otherwise.
func (s *Session) RecoveryKey() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.v.shownRecovery()
}

// MarkBackedUp says the recovery key was kept somewhere safe: this computer's copy goes and it cannot be shown again.
func (s *Session) MarkBackedUp() {
	s.mutate(func() { s.v.file.markRecoverySaved() })
}

// NewRecoveryKey makes a new recovery key for the key this computer has, seals it on the server and returns it for showing.
func (s *Session) NewRecoveryKey(ctx context.Context) (string, error) {
	s.mu.Lock()
	keyID, recovery, wrapped, ok := s.v.newRecovery()
	s.mu.Unlock()
	if !ok {
		return "", &Error{Code: CodeNoKey, Message: "This computer does not have your key."}
	}
	if err := s.call(ctx, "POST", "/api/keys/wrap", map[string]any{"keyId": keyID, "wrapped": wrapped}, 200, nil); err != nil {
		return "", err
	}
	s.mutate(func() { s.v.file.setRecovery(recovery, false) })
	return recovery.display(), nil
}
