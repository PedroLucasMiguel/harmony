package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewer(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{{"2.0.1", "2.0.0", true}, {"v2.1.0", "2.0.9", true}, {"2.0.0", "2.0.0", false}, {"1.9.9", "2.0.0", false}, {"2.0.0-rc1", "2.0.0", false}} {
		if got := newer(c.a, c.b); got != c.want {
			t.Errorf("newer(%q,%q)=%v", c.a, c.b, got)
		}
	}
}

func TestChecksumFromDigestOrFile(t *testing.T) {
	hex := strings.Repeat("ab", 32)
	a := &asset{Name: "harmony2-linux-amd64", Digest: "sha256:" + hex}
	if checksumOf(a, "") != hex {
		t.Fatal("the digest of the asset")
	}
	a.Digest = ""
	if checksumOf(a, "0000000000000000000000000000000000000000000000000000000000000000  other\n"+hex+" *harmony2-linux-amd64\n") != hex {
		t.Fatal("a line of the checksum file")
	}
	if checksumOf(a, "nothing") != "" {
		t.Fatal("no checksum is none")
	}
}

func TestDownloadVerifiesTheChecksum(t *testing.T) {
	body := []byte("a new build")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(body) }))
	defer server.Close()
	sum := sha256.Sum256(body)
	u := New()
	a := &asset{Name: assetName(), URL: server.URL, Size: int64(len(body))}
	path, err := u.fetch(context.Background(), a, hex.EncodeToString(sum[:]), Status{})
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	if data, _ := os.ReadFile(path); string(data) != string(body) {
		t.Fatal("the file is what was served")
	}
	if _, err := u.fetch(context.Background(), a, strings.Repeat("0", 64), Status{}); err == nil {
		t.Fatal("a download that does not match its checksum must be refused")
	}
	left, _ := filepath.Glob(filepath.Join(filepath.Dir(mustExecutable(t)), ".harmony-update-*"))
	if len(left) != 1 {
		t.Fatalf("only the good download is kept, found %v", left)
	}
}

func mustExecutable(t *testing.T) string {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return exe
}
