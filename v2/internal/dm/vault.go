package dm

import (
	"slices"
)

// vault is whose keys are whose and whether this computer can open your messages. It is the rules, not only the bytes,
// that make this client and Ciranda trust each other the same way, so they follow Ciranda's `Vault` (dm.rs).
//
// The server is not trusted with any of it. It says which key is whose, and it may lie: a key is only used for the
// person it is listed for, and one of theirs this computer has not accepted is marked. It numbers the messages, and it
// may replay or shuffle them (see open.go).
//
// A vault is not safe for concurrent use: the session's lock guards it.
type vault struct {
	state   KeyState
	failure string

	me       int
	identity *Identity
	identID  int
	onServer *ownKey
	file     *keyFile

	keys        map[int]Key
	current     map[int]int
	pairs       map[pairID]*pairKey
	unconfirmed map[int]map[int]bool

	nonces map[[nonceLen]byte]int
	mids   map[string]int
	texts  map[int]*textState
}

type pairID struct{ conversation, mine, theirs int }

func newVault(file *keyFile, me int) *vault {
	v := &vault{
		file: file, me: me, keys: map[int]Key{}, current: map[int]int{}, pairs: map[pairID]*pairKey{},
		unconfirmed: map[int]map[int]bool{}, nonces: map[[nonceLen]byte]int{}, mids: map[string]int{}, texts: map[int]*textState{},
	}
	v.identID, v.identity = file.current()
	return v
}

func (v *vault) ready() bool { return v.state == Ready }

func (v *vault) myKey() int {
	if v.identity == nil {
		return 0
	}
	return v.identID
}

// onKeys takes what the server said about everybody's keys and your own. `mine` is nil with `none` set for "this account
// has none", and nil without it for an answer that says nothing about it: only an explicit none means none, and taking
// anything else for it would throw away the key this computer has. It reports whether a key has to be made.
func (v *vault) onKeys(keys []Key, mine *ownKey, none bool) (create bool) {
	v.learn(keys)
	for _, k := range keys {
		if v.owner(k.ID) == k.UserID {
			v.current[k.UserID] = k.ID
		}
	}
	switch {
	case none:
		if v.identity != nil {
			v.identity, v.identID = nil, 0
			v.file.retireIdentity()
		}
		v.onServer = nil
		return true
	case mine != nil && mine.ID != 0 && mine.PublicKey != "" && mine.Wrapped != nil:
		if v.identity != nil && v.identID == mine.ID && v.identity.publicB64() == mine.PublicKey {
			v.state = Ready
		} else {
			v.state = Locked
		}
		v.onServer = mine
		return false
	}
	known, ok := v.keys[v.current[v.me]]
	if ok && v.identity != nil && v.identID == known.ID && v.identity.publicB64() == known.PublicKey {
		v.state = Ready
	} else {
		v.state, v.failure = Failed, "The server did not say which key is yours."
	}
	return false
}

// newIdentity makes an identity key and its recovery key, and the wrapping to publish.
func newIdentity() (*Identity, recoveryKey, string) {
	id, r := generateIdentity(), generateRecoveryKey()
	return id, r, wrap(id, r)
}

// adopt makes a key the server took the account's key from now on, and returns once it is on disk: the server already
// has its public half, and lost here it is lost for good.
func (v *vault) adopt(key *ownKey, identity *Identity, recovery recoveryKey, saved bool) error {
	v.file.setIdentity(key.ID, identity)
	v.file.setRecovery(recovery, saved)
	v.learn([]Key{{ID: key.ID, UserID: v.me, PublicKey: key.PublicKey}})
	v.current[v.me] = key.ID
	v.identity, v.identID = identity, key.ID
	v.onServer = key
	v.state = Ready
	return v.file.flush()
}

// unlock opens the account's key with the recovery key typed in; false if it is not the right one.
func (v *vault) unlock(typed string) (bool, error) {
	recovery, ok := parseRecoveryKey(typed)
	mine := v.onServer
	if !ok || mine == nil || mine.Wrapped == nil {
		return false, nil
	}
	pub, ok := publicKeyBytes(mine.PublicKey)
	if !ok {
		return false, nil
	}
	identity, ok := unwrap(*mine.Wrapped, pub, recovery)
	if !ok {
		return false, nil
	}
	return true, v.adopt(mine, identity, recovery, true)
}

// shownRecovery is the recovery key as shown, while this computer keeps it: from when it is made until the person says
// it is somewhere safe.
func (v *vault) shownRecovery() string {
	if v.file.recovery == nil {
		return ""
	}
	return v.file.recovery.display()
}

func (v *vault) needsBackup() bool { return v.ready() && !v.file.isRecoverySaved() }

// newRecovery is a new recovery key for the key this computer has, and its wrapping to send to the server.
func (v *vault) newRecovery() (keyID int, recovery recoveryKey, wrapped string, ok bool) {
	if v.identity == nil {
		return 0, recovery, "", false
	}
	recovery = generateRecoveryKey()
	return v.identID, recovery, wrap(v.identity, recovery), true
}

// learn takes public keys from anywhere the server sends them. A key is a row that never changes, so an id sent again
// with something else in it is not believed: the first answer stands.
func (v *vault) learn(keys []Key) {
	for _, k := range keys {
		if _, ok := v.keys[k.ID]; ok || k.ID == 0 {
			continue
		}
		v.keys[k.ID] = k
		// Key ids only grow: one newer than the one thought current (met in a message before the push that announces it)
		// is their current one.
		if cur, ok := v.current[k.UserID]; ok && cur < k.ID {
			v.current[k.UserID] = k.ID
		}
	}
}

func (v *vault) owner(key int) int { return v.keys[key].UserID }

// keyChanged is somebody publishing a new key (a keys:changed push).
func (v *vault) keyChanged(key Key) {
	v.learn([]Key{key})
	cur, ok := v.current[key.UserID]
	if v.owner(key.ID) == key.UserID && (!ok || cur < key.ID) {
		v.current[key.UserID] = key.ID
	}
	// Your own account has a new key, made on another computer: this one's is spent.
	if key.UserID == v.me && v.myKey() != key.ID {
		v.state = Locked
	}
}

// unknown lists the key ids among these that are not known yet.
func (v *vault) unknown(ids []int) []int {
	var out []int
	for _, id := range ids {
		if id != 0 && !slices.Contains(out, id) {
			if _, ok := v.keys[id]; !ok {
				out = append(out, id)
			}
		}
	}
	slices.Sort(out)
	return out
}

func (v *vault) peerHasKey(peer int) bool {
	_, ok := v.current[peer]
	return ok
}

func (v *vault) publicOf(key int) ([]byte, bool) {
	k, ok := v.keys[key]
	if !ok {
		return nil, false
	}
	return publicKeyBytes(k.PublicKey)
}

// pair is the agreed key for one conversation between your key `mine` and `theirs`, a key listed as `peer`'s. In a group
// each message is sealed once for every person in it, yourself included, so the "other" half may be your own key; in a
// pair it may not.
func (v *vault) pair(conversation, mine, peer, theirs int, group bool) *pairKey {
	// Their half has to be a key listed as theirs. Otherwise any key the server published, under any id, would open as the
	// other person's (or, paired with yours, as your own words).
	if (peer == v.me && !group) || v.owner(theirs) != peer {
		return nil
	}
	id := pairID{conversation, mine, theirs}
	if k := v.pairs[id]; k != nil {
		return k
	}
	pub, ok := v.publicOf(theirs)
	if !ok {
		return nil
	}
	identity := v.file.archive[mine]
	if v.identID == mine && v.identity != nil {
		identity = v.identity
	}
	if identity == nil {
		return nil
	}
	key := agreePairKey(identity, v.me, pub, peer, conversation)
	if key != nil {
		v.pairs[id] = key
	}
	return key
}

type sealed struct {
	text         string
	senderKey    int
	recipientKey int
}

// copyOf is one person's copy of a group message: the key it was sealed to and the sealed text.
type copyOf struct {
	K int    `json:"k"`
	S string `json:"s"`
}

type groupSealed struct {
	copies    map[int]copyOf
	senderKey int
}

// sealConfirmed seals for the other person, but never to a key of theirs not accepted here. The server says which key is
// theirs, and whoever holds a key it named reads what is sealed to it: so the first one met is pinned and taken, and a
// change after it waits for the person to accept it.
func (v *vault) sealConfirmed(conversation, peer int, aad string, plain []byte) (sealed, error) {
	if !v.ready() || v.myKey() == 0 {
		return sealed{}, &Error{Code: CodeNoKey}
	}
	v.pin(peer)
	theirs, ok := v.current[peer]
	if !ok {
		return sealed{}, &Error{Code: CodePeerHasNoKey}
	}
	if !v.isAccepted(peer, theirs) {
		return sealed{}, &Error{Code: CodeKeyNotConfirm}
	}
	key := v.pair(conversation, v.myKey(), peer, theirs, false)
	if key == nil {
		return sealed{}, &Error{Code: CodePeerHasNoKey}
	}
	return sealed{text: key.seal(aad, plain), senderKey: v.myKey(), recipientKey: theirs}, nil
}

// sealGroup seals for every person of a group: one copy each, under the key you share with them, and one for yourself.
// The same refusals as for a pair, about whoever is the first they apply to, because a message that skipped somebody
// whose key is in doubt would be a message they never get.
func (v *vault) sealGroup(conversation int, members []int, aad string, plain []byte) (groupSealed, error) {
	if !v.ready() || v.myKey() == 0 {
		return groupSealed{}, &Error{Code: CodeNoKey}
	}
	mine := v.myKey()
	out := groupSealed{copies: map[int]copyOf{}, senderKey: mine}
	for _, id := range members {
		theirs := mine
		if id != v.me {
			v.pin(id)
			cur, ok := v.current[id]
			if !ok {
				return groupSealed{}, &Error{Code: CodePeerHasNoKey, User: id}
			}
			if !v.isAccepted(id, cur) {
				return groupSealed{}, &Error{Code: CodeKeyNotConfirm, User: id}
			}
			theirs = cur
		}
		key := v.pair(conversation, mine, id, theirs, true)
		if key == nil {
			return groupSealed{}, &Error{Code: CodePeerHasNoKey, User: id}
		}
		out.copies[id] = copyOf{K: theirs, S: key.seal(aad, plain)}
	}
	return out, nil
}

func (v *vault) sealMessage(conversation, peer int, p payload) (sealed, error) {
	return v.sealConfirmed(conversation, peer, aadMessage(conversation, v.me), messageJSON(p))
}

func (v *vault) sealReactions(conversation, peer, message int, emoji []string) (sealed, error) {
	return v.sealConfirmed(conversation, peer, aadReaction(conversation, message, v.me), pad(marshal(emoji)))
}

func (v *vault) sealGroupMessage(conversation int, members []int, p payload) (groupSealed, error) {
	return v.sealGroup(conversation, members, aadMessage(conversation, v.me), messageJSON(p))
}

func (v *vault) sealGroupReactions(conversation int, members []int, message int, emoji []string) (groupSealed, error) {
	return v.sealGroup(conversation, members, aadReaction(conversation, message, v.me), pad(marshal(emoji)))
}

// Trust.

func (v *vault) safetyNumber(peer int) string {
	if v.identity == nil {
		return ""
	}
	cur, ok := v.current[peer]
	if !ok {
		return ""
	}
	theirs, ok := v.publicOf(cur)
	if !ok {
		return ""
	}
	return safetyNumber(identityPublic{v.me, v.identity.public[:]}, identityPublic{peer, theirs})
}

func (v *vault) currentPublic(peer int) string { return v.keys[v.current[peer]].PublicKey }

// pin remembers a person's key the first time it is seen, so a later change can be noticed.
func (v *vault) pin(peer int) {
	if cur, ok := v.current[peer]; ok && !v.file.hasPin(peer) {
		v.acceptUpTo(peer, cur)
	}
}

// acceptUpTo makes the key `id` the one to compare theirs against from now on, and accepts the older keys the directory
// lists as theirs with it: what they sealed before a change they made opens without a warning. Keys that turn up later
// are not.
func (v *vault) acceptUpTo(peer, id int) {
	var older []string
	for _, k := range v.keys {
		if k.UserID == peer && k.ID < id {
			older = append(older, k.PublicKey)
		}
	}
	v.file.accept(peer, older)
	if k, ok := v.keys[id]; ok && k.UserID == peer {
		v.file.setPin(peer, k.PublicKey)
	}
}

func (v *vault) isAccepted(peer, key int) bool {
	k, ok := v.keys[key]
	return ok && k.UserID == peer && v.file.isAccepted(peer, k.PublicKey)
}

func (v *vault) pinID(peer int) int {
	pin, ok := v.file.pins[peer]
	if !ok {
		return 0
	}
	lowest := 0
	for _, k := range v.keys {
		if k.UserID == peer && k.PublicKey == pin && (lowest == 0 || k.ID < lowest) {
			lowest = k.ID
		}
	}
	return lowest
}

// keyChangedFor says a person's current key is not one accepted for them, or something of theirs opened with a key
// between the pinned one and it that isn't. Usually a reinstall without the recovery key; it is also what somebody in the
// middle would look like, so it is said, not hidden. A key older than the pinned one that turns up now was never part of
// a change of theirs seen here: it is marked on its messages, and accepting the change does not accept it.
func (v *vault) keyChangedFor(peer int) bool {
	if !v.file.hasPin(peer) {
		return false
	}
	cur, ok := v.current[peer]
	if !ok {
		return false
	}
	since := v.pinID(peer)
	if !v.isAccepted(peer, cur) {
		return true
	}
	for k := range v.unconfirmed[peer] {
		if k > since && k < cur && !v.isAccepted(peer, k) {
			return true
		}
	}
	return false
}

// acceptKey is the change seen and accepted: their current key, and the ones between the pinned key and it, which are the change.
func (v *vault) acceptKey(peer int) {
	cur, ok := v.current[peer]
	if !ok {
		return
	}
	since := v.pinID(peer)
	var between []string
	for _, k := range v.keys {
		if k.UserID == peer && k.ID > since && k.ID < cur {
			between = append(between, k.PublicKey)
		}
	}
	v.file.accept(peer, between)
	if k, ok := v.keys[cur]; ok {
		v.file.setPin(peer, k.PublicKey)
		if verified, ok := v.file.verified[peer]; ok && verified != k.PublicKey {
			v.file.setVerified(peer, "")
		}
	}
	for id := range v.unconfirmed[peer] {
		if v.isAccepted(peer, id) {
			delete(v.unconfirmed[peer], id)
		}
	}
}

func (v *vault) verified(peer int) bool {
	kept, ok := v.file.verified[peer]
	now := v.currentPublic(peer)
	return ok && now != "" && kept == now
}

func (v *vault) setVerified(peer int, on bool) {
	key := ""
	if on {
		key = v.currentPublic(peer)
	}
	if key != "" {
		v.acceptKey(peer)
	}
	v.file.setVerified(peer, key)
}

func (v *vault) trust(peer int) Trust {
	return Trust{KeyChanged: v.keyChangedFor(peer), Verified: v.verified(peer)}
}
