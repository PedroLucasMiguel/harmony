// Package dm is the client side of private conversations: the cryptography, the keys kept on this computer, the trust
// rules and the session that turns what the server holds (sealed text it cannot read) into messages a screen can draw.
//
// It is wire compatible with the Electron client and with Ciranda, byte for byte. crypto.go and recovery.go are the
// primitives, keyfile.go and vault.go the keys and who is trusted, session*.go the conversations.
//
//   - Each person has one X25519 identity key; its private half leaves this computer only sealed under a recovery key.
//   - Two people agree a key per conversation and per pair of identity keys (X25519, then HKDF-SHA256).
//   - Everything is sealed with XChaCha20-Poly1305 under a random nonce, with what it is and where it belongs bound in
//     as associated data. Files are sealed under a fresh key each, which travels inside the sealed message.
//
// Sealed text is base64url without padding of `version | nonce | ciphertext+tag`.
package dm

import (
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"strings"

	"golang.org/x/crypto/chacha20poly1305"
)

const (
	formatVersion = 1
	nonceLen      = 24
	tagLen        = 16
)

var fileAAD = []byte("harmony-dm-v1/file")

func random(n int) []byte {
	out := make([]byte, n)
	_, _ = rand.Read(out)
	return out
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// unb64 reads base64url without padding; anything else is not one.
func unb64(text string) ([]byte, bool) {
	clean := strings.TrimSpace(text)
	if len(clean)%4 == 1 {
		return nil, false
	}
	for i := 0; i < len(clean); i++ {
		c := clean[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return nil, false
		}
	}
	out, err := base64.RawURLEncoding.DecodeString(clean)
	return out, err == nil
}

// publicKeyBytes is a public key as the server carries it: 32 bytes of base64url.
func publicKeyBytes(text string) ([]byte, bool) {
	b, ok := unb64(text)
	return b, ok && len(b) == 32
}

func i64(n int) []byte {
	var out [8]byte
	binary.BigEndian.PutUint64(out[:], uint64(int64(n)))
	return out[:]
}

func concat(parts ...[]byte) []byte {
	var n int
	for _, p := range parts {
		n += len(p)
	}
	out := make([]byte, 0, n)
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func newAEAD(key []byte) cipher.AEAD {
	a, err := chacha20poly1305.NewX(key)
	if err != nil {
		panic(err)
	}
	return a
}

func sealWith(a cipher.AEAD, aad, plain, nonce []byte) []byte {
	out := make([]byte, 0, 1+nonceLen+len(plain)+tagLen)
	out = append(out, formatVersion)
	out = append(out, nonce...)
	return a.Seal(out, nonce, plain, aad)
}

func openWith(a cipher.AEAD, aad, sealed []byte) ([]byte, bool) {
	if len(sealed) < 1+nonceLen+tagLen || sealed[0] != formatVersion {
		return nil, false
	}
	plain, err := a.Open(nil, sealed[1:1+nonceLen], sealed[1+nonceLen:], aad)
	return plain, err == nil
}

// Identity is your identity key.
type Identity struct {
	key    *ecdh.PrivateKey
	secret [32]byte
	public [32]byte
}

func identityFromSecret(secret []byte) (*Identity, error) {
	if len(secret) != 32 {
		return nil, fmt.Errorf("an identity key is 32 bytes")
	}
	key, err := ecdh.X25519().NewPrivateKey(secret)
	if err != nil {
		return nil, err
	}
	id := &Identity{key: key}
	copy(id.secret[:], secret)
	copy(id.public[:], key.PublicKey().Bytes())
	return id, nil
}

func generateIdentity() *Identity {
	id, err := identityFromSecret(random(32))
	if err != nil {
		panic(err)
	}
	return id
}

func (i *Identity) publicB64() string { return b64(i.public[:]) }

// agree is the shared secret with another public key, or false for one X25519 must never be used with.
func (i *Identity) agree(their []byte) ([]byte, bool) {
	pub, err := ecdh.X25519().NewPublicKey(their)
	if err != nil {
		return nil, false
	}
	shared, err := i.key.ECDH(pub)
	return shared, err == nil
}

// pairKey is the key two people share for one conversation and one pair of their identity keys.
type pairKey struct {
	key  [32]byte
	aead cipher.AEAD
}

func agreePairKey(mine *Identity, me int, their []byte, them, conversation int) *pairKey {
	shared, ok := mine.agree(their)
	if !ok {
		return nil
	}
	first, second := identityPublic{me, mine.public[:]}, identityPublic{them, their}
	if them < me {
		first, second = second, first
	}
	info := concat(i64(conversation), i64(first.id), first.key, i64(second.id), second.key)
	key, err := hkdf.Key(sha256.New, shared, []byte("harmony-dm-v1"), string(info), 32)
	if err != nil {
		return nil
	}
	pk := &pairKey{aead: newAEAD(key)}
	copy(pk.key[:], key)
	return pk
}

func (k *pairKey) seal(aad string, plain []byte) string {
	return b64(sealWith(k.aead, []byte(aad), plain, random(nonceLen)))
}

func (k *pairKey) open(aad, sealed string) ([]byte, bool) {
	b, ok := unb64(sealed)
	if !ok {
		return nil, false
	}
	return openWith(k.aead, []byte(aad), b)
}

// nonceOf is the random nonce of something sealed. A sealed text seen under two message ids is one sent twice.
func nonceOf(sealed string) ([nonceLen]byte, bool) {
	var out [nonceLen]byte
	b, ok := unb64(sealed)
	if !ok || len(b) < 1+nonceLen+tagLen || b[0] != formatVersion {
		return out, false
	}
	copy(out[:], b[1:1+nonceLen])
	return out, true
}

// What a sealed thing is and where it belongs, bound in as associated data. These strings are Ciranda's.
func aadMessage(conversation, sender int) string {
	return fmt.Sprintf("harmony-dm-v1/message/%d/%d", conversation, sender)
}

func aadReaction(conversation, message, user int) string {
	return fmt.Sprintf("harmony-dm-v1/reaction/%d/%d/%d", conversation, message, user)
}

// pad fills a message with spaces, which JSON ignores, to a multiple of 64 bytes (at least 128).
func pad(json []byte) []byte {
	target := (max(len(json), 128) + 63) / 64 * 64
	out := make([]byte, target)
	copy(out, json)
	for i := len(json); i < target; i++ {
		out[i] = ' '
	}
	return out
}

// sealFile seals a file under a key of its own; the key goes inside the sealed message that sends it.
func sealFile(plain []byte) (sealed []byte, key []byte) {
	key = random(32)
	return sealWith(newAEAD(key), fileAAD, plain, random(nonceLen)), key
}

func openFile(key, sealed []byte) ([]byte, bool) {
	if len(key) != 32 {
		return nil, false
	}
	return openWith(newAEAD(key), fileAAD, sealed)
}

type identityPublic struct {
	id  int
	key []byte
}

// safetyNumber is the same on both screens exactly when each sees the other's real key: thirty digits in six groups.
func safetyNumber(a, b identityPublic) string {
	first, second := a, b
	if b.id < a.id {
		first, second = b, a
	}
	digest := sha256.Sum256(concat([]byte("harmony-safety-v1"), i64(first.id), first.key, i64(second.id), second.key))
	groups := make([]string, 6)
	for i := range groups {
		var n uint64
		for _, c := range digest[i*5 : i*5+5] {
			n = n<<8 | uint64(c)
		}
		groups[i] = fmt.Sprintf("%05d", n%100_000)
	}
	return strings.Join(groups, " ")
}

func sha256Of(s string) []byte {
	sum := sha256.Sum256([]byte(s))
	return sum[:]
}
