package dm

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func fixedIdentities(t *testing.T) (*Identity, *Identity) {
	t.Helper()
	a, err := identityFromSecret(bytes.Repeat([]byte{0x11}, 32))
	if err != nil {
		t.Fatal(err)
	}
	b, err := identityFromSecret(bytes.Repeat([]byte{0x22}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return a, b
}

func mustUnb64(t *testing.T, s string) []byte {
	t.Helper()
	b, ok := unb64(s)
	if !ok {
		t.Fatalf("not base64url: %q", s)
	}
	return b
}

// The answers below were produced once by Ciranda's Rust (core/crypto.rs) and are pinned by the Electron client's
// tests too: a result that differs is two programs that cannot talk to each other.
func TestKnownAnswersAgreeWithCiranda(t *testing.T) {
	a, b := fixedIdentities(t)
	if a.publicB64() != "e06Qm75__kTEZaIgA31gjuNYl9Me-XLwf3SJLLD3PxM" || b.publicB64() != "D6poTtKIZ7l_Smot7l34zpdOdrcBjj8iocTPJnhXDyA" {
		t.Fatal("public keys differ")
	}

	const wantKey = "b0fc31987202b69061f05d8fb6f5209a170391eba63aaa4e056079cbd7050faf"
	ka := agreePairKey(a, 1, b.public[:], 2, 7)
	kb := agreePairKey(b, 2, a.public[:], 1, 7)
	if hex.EncodeToString(ka.key[:]) != wantKey || hex.EncodeToString(kb.key[:]) != wantKey {
		t.Fatal("pair key differs")
	}

	const sealed = "ATMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM4Fkr1GHru_b3hVjLtqVztcZHeCo3hqSFUr3hzlw"
	plain, ok := kb.open(aadMessage(7, 1), sealed)
	if !ok || string(plain) != `{"body":"oi"}` {
		t.Fatalf("a message of Ciranda's does not open: %q %v", plain, ok)
	}
	if _, ok := kb.open(aadMessage(7, 2), sealed); ok {
		t.Fatal("it belongs to the message of person 1")
	}
	again := b64(sealWith(kb.aead, []byte(aadMessage(7, 1)), plain, bytes.Repeat([]byte{0x33}, nonceLen)))
	if again != sealed {
		t.Fatalf("sealing the same bytes gives %s", again)
	}
	if n, ok := nonceOf(sealed); !ok || n != [nonceLen]byte(bytes.Repeat([]byte{0x33}, nonceLen)) {
		t.Fatal("nonce")
	}

	file, ok := openFile(bytes.Repeat([]byte{0x66}, 32), mustUnb64(t, "AXd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3dwAHN4bEUCaTQI39Vu7KX_vFf3RZlBpQO1ta"))
	if !ok || string(file) != "file bytes" {
		t.Fatal("a file of Ciranda's does not open")
	}

	if got := safetyNumber(identityPublic{1, a.public[:]}, identityPublic{2, b.public[:]}); got != "13418 66612 62703 17296 72420 61925" {
		t.Fatalf("safety number %s", got)
	}
	if got := safetyNumber(identityPublic{2, b.public[:]}, identityPublic{1, a.public[:]}); got != "13418 66612 62703 17296 72420 61925" {
		t.Fatal("not the same from the other side")
	}
}

func TestRecoveryKeyAndWrappingAgreeWithCiranda(t *testing.T) {
	var raw recoveryKey
	for i := range raw {
		raw[i] = byte(i * 13)
	}
	const shown = "006H-M9SM-8575-PT3N-GA7S-SADP-RF8D-VTQQ"
	if raw.display() != shown {
		t.Fatalf("display %s", raw.display())
	}
	for _, typed := range []string{shown, "006h m9sm 8575 pt3n ga7s sadp rf8d vtqq", "OO6H-M9SM-8575-PT3N-GA7S-SADP-RF8D-VTQQ", "006HM9SM8575PT3NGA7SSADPRF8DVTQQ"} {
		if got, ok := parseRecoveryKey(typed); !ok || got.display() != shown {
			t.Errorf("%q is read as %q", typed, got.display())
		}
	}
	one, _ := parseRecoveryKey("1111-1111-1111-1111-1111-1111-1111-1111")
	two, _ := parseRecoveryKey("IiLl-1111-1111-1111-1111-1111-1111-1111")
	if one != two {
		t.Error("I, L and 1 are not the same")
	}
	for _, bad := range []string{shown[:30], shown + "A", "U" + shown[1:], ""} {
		if _, ok := parseRecoveryKey(bad); ok {
			t.Errorf("%q should not be a recovery key", bad)
		}
	}
	if hex.EncodeToString(raw.wrappingKey()) != "1a1f7e72a5523fe600c53989e36590567655d765c156ff0dc2089825fcdbc1ba" {
		t.Fatal("wrapping key")
	}

	a, _ := fixedIdentities(t)
	const wrapped = "AVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVbWXuqBjNMZkhU8tgZjfsPQ6TJ0qumXZuJddZM4bcF3OtQx0QmCbOScd47xAgzUwvg"
	back, ok := unwrap(wrapped, a.public[:], raw)
	if !ok || back.secret != a.secret {
		t.Fatal("the wrapping of Ciranda's does not open")
	}
	again := b64(sealWith(newAEAD(raw.wrappingKey()), a.public[:], a.secret[:], bytes.Repeat([]byte{0x55}, nonceLen)))
	if again != wrapped {
		t.Fatal("making the same wrapping gives another")
	}
	other := generateRecoveryKey()
	if _, ok := unwrap(wrapped, a.public[:], other); ok {
		t.Fatal("another recovery key opened it")
	}
	if _, ok := unwrap(wrapped, generateIdentity().public[:], raw); ok {
		t.Fatal("a wrapping is bound to its public key")
	}
}

func TestSealedThingsOpenOnlyWhereTheyBelong(t *testing.T) {
	alice, bob, eve := generateIdentity(), generateIdentity(), generateIdentity()
	a := agreePairKey(alice, 1, bob.public[:], 2, 7)
	sealed := a.seal(aadReaction(7, 100, 1), []byte(`["x"]`))
	b := agreePairKey(bob, 2, alice.public[:], 1, 7)
	if _, ok := b.open(aadReaction(7, 100, 1), sealed); !ok {
		t.Fatal("the other person cannot open it")
	}
	for name, k := range map[string]*pairKey{"eve": agreePairKey(eve, 3, alice.public[:], 1, 7), "another conversation": agreePairKey(bob, 2, alice.public[:], 1, 8)} {
		if _, ok := k.open(aadReaction(7, 100, 1), sealed); ok {
			t.Errorf("%s opened it", name)
		}
	}
	for _, aad := range []string{aadReaction(7, 101, 1), aadReaction(7, 100, 2), aadMessage(7, 1)} {
		if _, ok := a.open(aad, sealed); ok {
			t.Errorf("opened as %s", aad)
		}
	}
	if agreePairKey(alice, 1, make([]byte, 32), 2, 7) != nil {
		t.Fatal("a small-order key must be refused")
	}
}

func TestPadding(t *testing.T) {
	if len(pad([]byte(`{"body":"hi"}`))) != 128 || len(pad(bytes.Repeat([]byte("x"), 129))) != 192 || len(pad(bytes.Repeat([]byte("x"), 128))) != 128 {
		t.Fatal("padding")
	}
}
