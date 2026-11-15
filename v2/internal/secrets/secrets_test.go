package secrets

import "testing"

func TestRoundTrip(t *testing.T) {
	key := "secrets-test-item"
	_ = Delete(key)
	if _, err := Get(key); err != ErrNotFound {
		t.Fatalf("want not found, got %v", err)
	}
	if err := Set(key, []byte("hunter22 ünï")); err != nil {
		t.Fatal(err)
	}
	if err := Set(key, []byte("second")); err != nil {
		t.Fatal(err)
	}
	got, err := Get(key)
	if err != nil || string(got) != "second" {
		t.Fatalf("got %q %v", got, err)
	}
	if err := Delete(key); err != nil {
		t.Fatal(err)
	}
	if _, err := Get(key); err != ErrNotFound {
		t.Fatalf("after delete: %v", err)
	}
	if err := Delete(key); err != nil {
		t.Fatal(err)
	}
}
