package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	sumsLimit  = 1 << 20
	maxPercent = 100
)

// unsupportedReason is why this build could not replace itself, or "".
func unsupportedReason() string {
	exe, err := os.Executable()
	if err != nil {
		return "readonly"
	}
	if strings.Contains(exe, "go-build") {
		return "development"
	}
	dir, err := os.CreateTemp(filepath.Dir(exe), ".harmony-update-check-*")
	if err != nil {
		return "readonly"
	}
	_ = dir.Close()
	_ = os.Remove(dir.Name())
	return ""
}

// Download fetches the build for this system next to the running program, checks it against the checksum the release states, and leaves it ready to be put in place.
func (u *Updater) Download() {
	u.mu.Lock()
	rel, a := u.found, u.asset
	status := u.status
	u.mu.Unlock()
	if a == nil || (status.State != Available && status.State != Failed) {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	u.mu.Lock()
	u.cancel = cancel
	u.mu.Unlock()
	go func() {
		defer cancel()
		fail := func(err error) {
			u.set(Status{State: Failed, Version: status.Version, Page: status.Page, Error: err.Error()})
		}
		u.set(Status{State: Downloading, Version: status.Version, Page: status.Page})
		want, err := u.checksum(ctx, rel, a)
		if err != nil {
			fail(err)
			return
		}
		path, err := u.fetch(ctx, a, want, status)
		if err != nil {
			fail(err)
			return
		}
		u.mu.Lock()
		u.ready = path
		u.mu.Unlock()
		u.set(Status{State: Ready, Version: status.Version, Page: status.Page})
	}()
}

func (u *Updater) checksum(ctx context.Context, rel *release, a *asset) (string, error) {
	var sums string
	for _, other := range rel.Assets {
		if strings.EqualFold(other.Name, a.Name+".sha256") || strings.EqualFold(other.Name, "SHA256SUMS") || strings.EqualFold(other.Name, "SHA256SUMS.txt") {
			body, err := get(ctx, other.URL)
			if err != nil {
				return "", err
			}
			data, _ := io.ReadAll(io.LimitReader(body, sumsLimit))
			_ = body.Close()
			sums = string(data)
			break
		}
	}
	want := checksumOf(a, sums)
	if want == "" {
		return "", errors.New("the release states no checksum for this build, so it is not installed from here")
	}
	return want, nil
}

func get(ctx context.Context, url string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Harmony-v2")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		_ = res.Body.Close()
		return nil, fmt.Errorf("the download answered %d", res.StatusCode)
	}
	return res.Body, nil
}

// fetch writes the download beside the running program so that putting it in place is a rename, and returns its path once its checksum is right.
func (u *Updater) fetch(ctx context.Context, a *asset, want string, status Status) (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	body, err := get(ctx, a.URL)
	if err != nil {
		return "", err
	}
	defer body.Close()
	file, err := os.CreateTemp(filepath.Dir(exe), ".harmony-update-*")
	if err != nil {
		return "", fmt.Errorf("the program's folder cannot be written to: %w", err)
	}
	done := false
	defer func() {
		if !done {
			_ = file.Close()
			_ = os.Remove(file.Name())
		}
	}()
	hash := sha256.New()
	var got int64
	last := -1
	buf := make([]byte, 64<<10)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			hash.Write(buf[:n])
			if _, werr := file.Write(buf[:n]); werr != nil {
				return "", werr
			}
			got += int64(n)
			if a.Size > 0 {
				if p := int(got * maxPercent / a.Size); p != last {
					last = p
					u.set(Status{State: Downloading, Version: status.Version, Page: status.Page, Percent: min(p, maxPercent)})
				}
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
	}
	if hex.EncodeToString(hash.Sum(nil)) != want {
		return "", errors.New("the download does not match its checksum, so it was thrown away")
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	if err := os.Chmod(file.Name(), 0o755); err != nil {
		return "", err
	}
	done = true
	return file.Name(), nil
}

// Install puts the downloaded build in place of the running program and starts it; Relaunch then quits this one.
func (u *Updater) Install() error {
	u.mu.Lock()
	path := u.ready
	u.mu.Unlock()
	if path == "" || u.Status().State != Ready {
		return errors.New("nothing is downloaded")
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	if runtime.GOOS == "windows" {
		// A running program cannot be overwritten on Windows, but it can be renamed.
		_ = os.Remove(exe + ".old")
		if err := os.Rename(exe, exe+".old"); err != nil {
			return err
		}
		if err := os.Rename(path, exe); err != nil {
			_ = os.Rename(exe+".old", exe)
			return err
		}
	} else if err := os.Rename(path, exe); err != nil {
		return err
	}
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	time.AfterFunc(100*time.Millisecond, func() {
		if u.Relaunch != nil {
			u.Relaunch()
		}
	})
	return nil
}
