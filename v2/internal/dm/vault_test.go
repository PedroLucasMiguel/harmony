package dm

import (
	"errors"
	"path/filepath"
	"testing"
)

func newKey(t *testing.T, v *vault, id int) *Identity {
	t.Helper()
	if !v.onKeys(nil, nil, true) {
		t.Fatal("a vault with no key must ask for one")
	}
	identity, recovery, wrapped := newIdentity()
	if err := v.adopt(&ownKey{Key: Key{ID: id, UserID: v.me, PublicKey: identity.publicB64()}, Wrapped: &wrapped}, identity, recovery, false); err != nil {
		t.Fatal(err)
	}
	return identity
}

func pairUp(t *testing.T) (a, b *vault) {
	t.Helper()
	a, b = newVault(newKeyFile(), 1), newVault(newKeyFile(), 2)
	ia, ib := newKey(t, a, 10), newKey(t, b, 20)
	a.keyChanged(Key{ID: 20, UserID: 2, PublicKey: ib.publicB64()})
	b.keyChanged(Key{ID: 10, UserID: 1, PublicKey: ia.publicB64()})
	return a, b
}

func asSent(s sealed, id, from int) *rawMessage {
	return &rawMessage{ID: id, Conversation: 5, User: from, Kind: "text", SenderKey: s.senderKey, RecipientKey: s.recipientKey, Sealed: s.text, CreatedAt: 1}
}

func sentAt(s sealed, id, from int, editedAt int64) *rawMessage {
	m := asSent(s, id, from)
	m.EditedAt = editedAt
	return m
}

func editOf(m *Message, body string) payload {
	of := m.ID
	return payload{Body: body, Reply: m.Reply, Mid: m.mid, Rev: m.Rev + 1, Of: &of}
}

func seal(t *testing.T, v *vault, peer int, p payload) sealed {
	t.Helper()
	s, err := v.sealMessage(5, peer, p)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func sealCode(v *vault, peer int, p payload) string {
	_, err := v.sealMessage(5, peer, p)
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

func TestMessagesOpenOnBothSidesAndOnlyWhereTheyBelong(t *testing.T) {
	a, b := pairUp(t)
	m := asSent(seal(t, a, 2, payload{Body: "oi, tudo bem?"}), 1, 1)
	if got := b.openMessage(m, 1).Body; got != "oi, tudo bem?" {
		t.Fatalf("the other side reads %q", got)
	}
	if got := a.openMessage(m, 2).Body; got != "oi, tudo bem?" {
		t.Fatalf("your own message does not open on your computer: %q", got)
	}
	moved := *m
	moved.User = 2
	if !b.openMessage(&moved, 1).Unreadable {
		t.Fatal("a message moved to another sender must not open")
	}
	moved = *m
	moved.Conversation = 6
	if !b.openMessage(&moved, 1).Unreadable {
		t.Fatal("a message moved to another conversation must not open")
	}
}

func TestReactionsCountAcrossBothPeopleAndStayOnTheirMessage(t *testing.T) {
	a, b := pairUp(t)
	ra, err := a.sealReactions(5, 2, 9, []string{"👍", "🔥"})
	if err != nil {
		t.Fatal(err)
	}
	rb, err := b.sealReactions(5, 1, 9, []string{"👍"})
	if err != nil {
		t.Fatal(err)
	}
	sealedReactions := []rawReaction{
		{User: 1, SenderKey: ra.senderKey, RecipientKey: ra.recipientKey, Sealed: ra.text},
		{User: 2, SenderKey: rb.senderKey, RecipientKey: rb.recipientKey, Sealed: rb.text},
	}
	got := b.openReactions(5, false, 1, 9, sealedReactions)
	if len(got) != 2 || got[0].Emoji != "👍" || got[0].Count != 2 || got[1].Emoji != "🔥" {
		t.Fatalf("counted %+v", got)
	}
	if got := b.openReactions(5, false, 1, 10, sealedReactions); len(got) != 0 {
		t.Fatalf("moved to another message they must open as nothing, got %+v", got)
	}
}

func TestPayloadIsWrittenAsCirandaWritesIt(t *testing.T) {
	a, b := pairUp(t)
	s := seal(t, a, 2, payload{Body: "oi"})
	key := b.pair(5, 20, 1, 10, false)
	plain, ok := key.open(aadMessage(5, 1), s.text)
	if !ok || len(plain) != 128 {
		t.Fatalf("padded to 128 at least, got %d", len(plain))
	}
	p, _ := parsePayload(plain)
	if string(plain[:len(marshal(p))]) != `{"body":"oi","mid":"`+p.Mid+`"}` {
		t.Fatalf("a new message carries its body and its id and nothing else: %s", plain)
	}
	of := 7
	edit := seal(t, a, 2, payload{Body: "oi!", Mid: p.Mid, Rev: 1, Of: &of})
	plain, _ = key.open(aadMessage(5, 1), edit.text)
	if got := string(plain[:len(marshal(payload{Body: "oi!", Mid: p.Mid, Rev: 1, Of: &of}))]); got != `{"body":"oi!","mid":"`+p.Mid+`","rev":1,"of":7}` {
		t.Fatalf("an edit: %s", got)
	}
}

func TestKeyStates(t *testing.T) {
	identity, recovery, wrapped := newIdentity()
	v := newVault(newKeyFile(), 1)
	mine := &ownKey{Key: Key{ID: 3, UserID: 1, PublicKey: identity.publicB64()}, Wrapped: &wrapped}
	if v.onKeys(nil, mine, false) || v.state != Locked {
		t.Fatal("a key this computer lacks locks it")
	}
	if ok, _ := v.unlock("ABCD-EFGH"); ok {
		t.Fatal("a short key unlocked")
	}
	if ok, _ := v.unlock(generateRecoveryKey().display()); ok {
		t.Fatal("another recovery key unlocked")
	}
	if ok, err := v.unlock(recovery.display()); !ok || err != nil || v.state != Ready || v.needsBackup() {
		t.Fatal("the right recovery key must unlock, and need no backup")
	}

	a, _ := pairUp(t)
	a.keyChanged(Key{ID: 11, UserID: 1, PublicKey: generateIdentity().publicB64()})
	if a.state != Locked || sealCode(a, 2, payload{}) != CodeNoKey {
		t.Fatal("a key made elsewhere locks this computer")
	}

	a, _ = pairUp(t)
	own := Key{ID: 10, UserID: 1, PublicKey: a.identity.publicB64()}
	if a.onKeys([]Key{own}, nil, false) || a.myKey() != 10 || a.state != Ready {
		t.Fatal("an unclear answer must keep the key")
	}
	if !a.onKeys(nil, nil, true) || a.myKey() != 0 {
		t.Fatal("a null answer retires it")
	}
}

func TestSealedToAnArchivedKeyStillOpens(t *testing.T) {
	a, b := pairUp(t)
	before := seal(t, b, 1, payload{Body: "guardado"})
	a.onKeys(nil, nil, true)
	identity, recovery, wrapped := newIdentity()
	if err := a.adopt(&ownKey{Key: Key{ID: 11, UserID: 1, PublicKey: identity.publicB64()}, Wrapped: &wrapped}, identity, recovery, false); err != nil {
		t.Fatal(err)
	}
	if got := a.openMessage(asSent(before, 1, 2), 2).Body; got != "guardado" {
		t.Fatalf("sealed to the old key, got %q", got)
	}
}

func TestRecoveryKeyIsShownOnlyUntilKept(t *testing.T) {
	a, _ := pairUp(t)
	if !a.needsBackup() || len(a.shownRecovery()) != 39 {
		t.Fatal("a new recovery key is shown")
	}
	a.file.markRecoverySaved()
	if a.needsBackup() || a.shownRecovery() != "" {
		t.Fatal("kept, it is not shown again")
	}
	if _, _, _, ok := a.newRecovery(); !ok {
		t.Fatal("a new one can be made while the key is here")
	}
}

func TestChangedKeysWaitForAcceptance(t *testing.T) {
	a, _ := pairUp(t)
	a.pin(2)
	if a.keyChangedFor(2) {
		t.Fatal("nothing changed yet")
	}
	a.keyChanged(Key{ID: 21, UserID: 2, PublicKey: generateIdentity().publicB64()})
	if !a.keyChangedFor(2) {
		t.Fatal("a change is noticed")
	}
	a.acceptKey(2)
	if a.keyChangedFor(2) {
		t.Fatal("accepted")
	}

	a, _ = pairUp(t)
	if s := seal(t, a, 2, payload{Body: "x"}); s.recipientKey != 20 {
		t.Fatal("first contact: their key is taken")
	}
	a.keyChanged(Key{ID: 21, UserID: 2, PublicKey: generateIdentity().publicB64()})
	if sealCode(a, 2, payload{}) != CodeKeyNotConfirm {
		t.Fatal("nothing is sealed to a changed key")
	}
	if _, err := a.sealReactions(5, 2, 9, []string{"👍"}); err == nil {
		t.Fatal("nor a reaction")
	}
	a.acceptKey(2)
	if s := seal(t, a, 2, payload{Body: "x"}); s.recipientKey != 21 {
		t.Fatal("accepted: sealed to the new key")
	}
	a.keyChanged(Key{ID: 22, UserID: 2, PublicKey: generateIdentity().publicB64()})
	a.setVerified(2, true)
	if s := seal(t, a, 2, payload{Body: "x"}); s.recipientKey != 22 || !a.verified(2) {
		t.Fatal("verifying accepts a change too")
	}
	a.keyChanged(Key{ID: 23, UserID: 2, PublicKey: generateIdentity().publicB64()})
	if a.verified(2) {
		t.Fatal("verified is a statement about one key")
	}
}

// forged is a message the server made up: a key it published as somebody's, and a text sealed with it to `to`.
func forged(t *testing.T, to *vault, key, owner int, body string) (Key, sealed) {
	t.Helper()
	server := generateIdentity()
	pk := agreePairKey(server, 2, to.identity.public[:], to.me, 5)
	p := messageJSON(payload{Body: body})
	return Key{ID: key, UserID: owner, PublicKey: server.publicB64()}, sealed{text: pk.seal(aadMessage(5, 2), p), senderKey: key, recipientKey: to.identID}
}

func TestKeysThatAreNotThePeersAreNotTrusted(t *testing.T) {
	a, _ := pairUp(t)
	a.pin(2)
	key, s := forged(t, a, 30, 3, "pix pra essa conta")
	a.learn([]Key{key})
	if !a.openMessage(asSent(s, 1, 2), 2).Unreadable || a.keyChangedFor(2) {
		t.Fatal("a key listed as somebody else's is refused outright")
	}
	key, s = forged(t, a, 31, 2, "pix pra essa conta")
	a.learn([]Key{key})
	if m := a.openMessage(asSent(s, 2, 2), 2); !m.Unconfirmed || !a.keyChangedFor(2) {
		t.Fatal("a key listed as theirs but never accepted is marked and said")
	}
}

func TestAcceptingAChangeDoesNotAcceptAKeySlippedIntoHistory(t *testing.T) {
	a, _ := pairUp(t)
	a.pin(2)
	key, s := forged(t, a, 5, 2, "antigo")
	a.learn([]Key{key})
	slipped := asSent(s, 1, 2)
	if !a.openMessage(slipped, 2).Unconfirmed || a.keyChangedFor(2) {
		t.Fatal("older than the pinned key: marked on the message, not a change of theirs")
	}
	key, s = forged(t, a, 21, 2, "troquei de pc")
	a.learn([]Key{key})
	if !a.keyChangedFor(2) {
		t.Fatal("a newer key is a change")
	}
	a.acceptKey(2)
	if a.keyChangedFor(2) || a.openMessage(asSent(s, 2, 2), 2).Unconfirmed {
		t.Fatal("accepted")
	}
	if !a.openMessage(slipped, 2).Unconfirmed {
		t.Fatal("the slipped key stays marked")
	}
}

func TestReplayedAndSwappedMessagesAreRefused(t *testing.T) {
	a, b := pairUp(t)
	one, two := seal(t, a, 2, payload{Body: "um"}), seal(t, a, 2, payload{Body: "dois"})
	if b.openMessage(asSent(one, 1, 1), 1).Body != "um" || b.openMessage(asSent(two, 2, 1), 1).Body != "dois" {
		t.Fatal("they open")
	}
	if b.openMessage(asSent(one, 1, 1), 1).Body != "um" {
		t.Fatal("the same message again is fine")
	}
	if again := b.openMessage(asSent(one, 3, 1), 1); !again.OutOfPlace || again.Body != "" {
		t.Fatal("sent again under a new id")
	}
	if !b.openMessage(asSent(two, 1, 1), 1).OutOfPlace || !b.openMessage(asSent(one, 2, 1), 1).OutOfPlace {
		t.Fatal("swapped")
	}
	if b.openMessage(asSent(seal(t, a, 2, payload{}), 3, 1), 1).OutOfPlace {
		t.Fatal("a refused text left id 3 free")
	}

	old, err := a.sealConfirmed(5, 2, aadMessage(5, 1), pad([]byte(`{"body":"antigo"}`)))
	if err != nil {
		t.Fatal(err)
	}
	if b.openMessage(asSent(old, 7, 1), 1).Body != "antigo" || !b.openMessage(asSent(old, 9, 1), 1).OutOfPlace {
		t.Fatal("one sealed before messages had ids is told by its nonce")
	}
}

func TestAnEarlierTextPutBackIsNotShown(t *testing.T) {
	a, b := pairUp(t)
	first := seal(t, a, 2, payload{Body: "5 reais"})
	sent := a.openMessage(asSent(first, 4, 1), 2)
	edit := seal(t, a, 2, editOf(sent, "50 reais"))
	if b.openMessage(sentAt(first, 4, 1, 0), 1).Body != "5 reais" || b.openMessage(sentAt(edit, 4, 1, 2), 1).Body != "50 reais" {
		t.Fatal("the edit replaces the text")
	}
	back := b.openMessage(sentAt(first, 4, 1, 3), 1)
	if back.Body != "50 reais" || back.OutOfPlace {
		t.Fatalf("the earlier text put back: the newer one stays, got %q", back.Body)
	}

	d := newVault(newKeyFile(), 2)
	d.file.setIdentity(b.identID, b.identity)
	d.identID, d.identity = d.file.current()
	d.onKeys([]Key{{ID: 10, UserID: 1, PublicKey: a.identity.publicB64()}}, &ownKey{Key: Key{ID: 20, UserID: 2, PublicKey: b.identity.publicB64()}, Wrapped: new(string)}, false)
	if !d.openMessage(sentAt(edit, 6, 1, 2), 1).OutOfPlace {
		t.Fatal("an edit still cannot go on another message")
	}
}

func TestALateOriginalDoesNotReplaceItsEdit(t *testing.T) {
	a, b := pairUp(t)
	first := seal(t, a, 2, payload{Body: "bom dia"})
	sent := a.openMessage(asSent(first, 4, 1), 2)
	edit := seal(t, a, 2, editOf(sent, "boa tarde"))
	if b.openMessage(sentAt(edit, 4, 1, 2), 1).Body != "boa tarde" {
		t.Fatal("the edit")
	}
	if late := b.openMessage(sentAt(first, 4, 1, 0), 1); late.Body != "boa tarde" || late.OutOfPlace {
		t.Fatal("it waited for its key; the edit stays")
	}
}

func TestEditsFromAComputerThatMissedOneAreTaken(t *testing.T) {
	a, b := pairUp(t)
	first := seal(t, a, 2, payload{Body: "v1"})
	sent := a.openMessage(asSent(first, 4, 1), 2)
	second := seal(t, a, 2, editOf(sent, "v2"))
	seen := a.openMessage(sentAt(second, 4, 1, 2), 2)
	third := seal(t, a, 2, editOf(seen, "v3"))
	for _, c := range []struct {
		s    sealed
		at   int64
		want string
	}{{first, 0, "v1"}, {second, 2, "v2"}, {third, 3, "v3"}} {
		if got := b.openMessage(sentAt(c.s, 4, 1, c.at), 1).Body; got != c.want {
			t.Fatalf("got %q want %q", got, c.want)
		}
	}
	stale := seal(t, a, 2, editOf(sent, "v4"))
	if b.openMessage(sentAt(stale, 4, 1, 4), 1).Body != "v4" {
		t.Fatal("their other computer only saw v1, so its edit counts 1: newer all the same")
	}
	bare, _ := a.sealConfirmed(5, 2, aadMessage(5, 1), pad([]byte(`{"body":"v5"}`)))
	if m := b.openMessage(sentAt(bare, 4, 1, 5), 1); m.Body != "v5" || m.OutOfPlace {
		t.Fatal("an edit sealed without an id or a count")
	}
}

func TestWhatTheSessionLetsGoTheVaultForgets(t *testing.T) {
	a, b := pairUp(t)
	one, two := seal(t, a, 2, payload{Body: "um"}), seal(t, a, 2, payload{Body: "dois"})
	b.openMessage(asSent(one, 1, 1), 1)
	b.openMessage(asSent(two, 2, 1), 1)
	b.forgetAllBut(map[int]bool{1: true})
	if len(b.texts) != 1 || len(b.nonces) != 1 || len(b.mids) != 1 {
		t.Fatal("only message 1 stays remembered")
	}
	if !b.openMessage(asSent(one, 3, 1), 1).OutOfPlace {
		t.Fatal("a message kept is still told replayed")
	}
	b.forgetAllBut(nil)
	if b.openMessage(asSent(one, 1, 1), 1).Body != "um" {
		t.Fatal("loaded again, it opens as before")
	}
}

func TestGroupMessagesAreSealedOncePerMember(t *testing.T) {
	vs := map[int]*vault{}
	keys := map[int]Key{}
	for id := 1; id <= 3; id++ {
		vs[id] = newVault(newKeyFile(), id)
		identity := newKey(t, vs[id], id*10)
		keys[id] = Key{ID: id * 10, UserID: id, PublicKey: identity.publicB64()}
	}
	for _, v := range vs {
		for _, k := range keys {
			v.keyChanged(k)
		}
	}
	members := []int{1, 2, 3}
	s, err := vs[1].sealGroupMessage(5, members, payload{Body: "oi grupo"})
	if err != nil || len(s.copies) != 3 {
		t.Fatalf("one copy each: %v %d", err, len(s.copies))
	}
	for id := 1; id <= 3; id++ {
		c := s.copies[id]
		m := &rawMessage{ID: 1, Conversation: 5, User: 1, Kind: "text", SenderKey: s.senderKey, RecipientKey: c.K, Sealed: c.S}
		if got := vs[id].openMessage(m, 0).Body; got != "oi grupo" {
			t.Errorf("member %d reads %q", id, got)
		}
	}
	other := s.copies[2]
	wrong := &rawMessage{ID: 1, Conversation: 5, User: 1, Kind: "text", SenderKey: s.senderKey, RecipientKey: other.K, Sealed: other.S}
	if !vs[3].openMessage(wrong, 0).Unreadable {
		t.Fatal("somebody else's copy opened")
	}
	r, err := vs[2].sealGroupReactions(5, members, 1, []string{"🔥"})
	if err != nil {
		t.Fatal(err)
	}
	c := r.copies[3]
	got := vs[3].openReactions(5, true, 0, 1, []rawReaction{{User: 2, SenderKey: r.senderKey, RecipientKey: c.K, Sealed: c.S}})
	if len(got) != 1 || got[0].Emoji != "🔥" {
		t.Fatalf("group reaction %+v", got)
	}
}

func TestKeysSurviveARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keys.json")
	file, err := openKeyFile(path)
	if err != nil {
		t.Fatal(err)
	}
	v := newVault(file, 1)
	identity := newKey(t, v, 10)
	v.keyChanged(Key{ID: 20, UserID: 2, PublicKey: generateIdentity().publicB64()})
	v.pin(2)
	v.file.setVerified(2, v.currentPublic(2))
	recovery := v.shownRecovery()

	again, err := openKeyFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if id, got := again.current(); id != 10 || got.secret != identity.secret {
		t.Fatal("the identity did not come back")
	}
	if again.recovery.display() != recovery || again.recoverySaved {
		t.Fatal("the recovery key is kept until it is saved")
	}
	if again.pins[2] != v.currentPublic(2) || again.verified[2] != v.currentPublic(2) {
		t.Fatal("pins and verified keys survive")
	}
	again.markRecoverySaved()
	last, _ := openKeyFile(path)
	if last.recovery != nil || !last.recoverySaved {
		t.Fatal("saved, the recovery key goes")
	}
	v.onKeys(nil, nil, true)
	retired, _ := openKeyFile(path)
	if retired.archive[10] == nil || retired.keyID != 0 {
		t.Fatal("a retired key is archived")
	}
}
