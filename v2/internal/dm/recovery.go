package dm

import (
	"crypto/hkdf"
	"crypto/sha256"
	"strings"
	"unicode"
)

// Crockford's base32: no I, L, O or U, so nothing in it is mistaken for something else when copied.
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

const recoveryBytes = 20

// recoveryKey is 160 random bits, shown as 32 characters in eight groups of four. It opens your identity key on a
// computer that does not have it yet.
type recoveryKey [recoveryBytes]byte

func generateRecoveryKey() recoveryKey {
	var r recoveryKey
	copy(r[:], random(recoveryBytes))
	return r
}

// parseRecoveryKey reads one back however it was typed: any case, with or without dashes and spaces, and with the
// letters people confuse (O for 0, I and L for 1) taken as what they meant.
func parseRecoveryKey(text string) (recoveryKey, bool) {
	var out recoveryKey
	var bits uint32
	n, at := 0, 0
	for _, raw := range text {
		if unicode.IsSpace(raw) || raw == '-' {
			continue
		}
		c := unicode.ToUpper(raw)
		switch c {
		case 'O':
			c = '0'
		case 'I', 'L':
			c = '1'
		}
		v := strings.IndexRune(crockford, c)
		if v < 0 {
			return out, false
		}
		bits = bits<<5 | uint32(v)
		n += 5
		if n >= 8 {
			n -= 8
			if at >= recoveryBytes {
				return out, false
			}
			out[at] = byte(bits >> n)
			at++
			bits &= 1<<n - 1
		}
	}
	return out, at == recoveryBytes && n == 0
}

func (r recoveryKey) display() string {
	var sb strings.Builder
	var bits uint32
	n := 0
	for _, b := range r {
		bits = bits<<8 | uint32(b)
		n += 8
		for n >= 5 {
			n -= 5
			if sb.Len() > 0 && (sb.Len()+1)%5 == 0 {
				sb.WriteByte('-')
			}
			sb.WriteByte(crockford[(bits>>n)&31])
		}
		bits &= 1<<n - 1
	}
	return sb.String()
}

func (r recoveryKey) wrappingKey() []byte {
	key, err := hkdf.Key(sha256.New, r[:], []byte("harmony-recovery-v1"), "wrap identity", 32)
	if err != nil {
		panic(err)
	}
	return key
}

// wrap is the identity key's private half sealed under the recovery key: what the server keeps. The public key is bound
// in, so a wrapping cannot be swapped for another.
func wrap(id *Identity, r recoveryKey) string {
	return b64(sealWith(newAEAD(r.wrappingKey()), id.public[:], id.secret[:], random(nonceLen)))
}

// unwrap is the identity key back out of a wrapping, if this recovery key is the one it was sealed under.
func unwrap(wrapped string, public []byte, r recoveryKey) (*Identity, bool) {
	sealed, ok := unb64(wrapped)
	if !ok {
		return nil, false
	}
	plain, ok := openWith(newAEAD(r.wrappingKey()), public, sealed)
	if !ok || len(plain) != 32 {
		return nil, false
	}
	id, err := identityFromSecret(plain)
	if err != nil || string(id.public[:]) != string(public) {
		return nil, false
	}
	return id, true
}
