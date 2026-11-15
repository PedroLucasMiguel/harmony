// Package updater checks the project's GitHub Releases for a newer build of this client, downloads the one for this system and replaces the running program with it.
package updater

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Version is this build's version; a release build sets it with -ldflags "-X harmony/v2/internal/updater.Version=2.1.0".
var Version = "2.0.0"

const (
	owner       = "PedroLucasMiguel"
	repo        = "harmony"
	firstCheck  = 15 * time.Second
	checkEvery  = 30 * time.Minute
	recheckGap  = 10 * time.Minute
	staleCheck  = time.Minute
	checkTimout = 20 * time.Second
)

// State is where an update stands.
type State int

const (
	Idle State = iota
	Checking
	Latest
	// Available is a newer release with a build for this system; Missing is a newer release with none (the project publishes it for other systems or for the Electron client only).
	Available
	Missing
	Downloading
	Ready
	Failed
	Unsupported
)

// Status is everything the settings page shows, replaced whole at every change.
type Status struct {
	State   State
	Current string
	Version string
	// Page is the release's own page, where its notes are.
	Page    string
	Percent int
	Error   string
	// Reason says why this build cannot update itself ("development" or "readonly"), for the words.
	Reason string
}

type release struct {
	Tag    string  `json:"tag_name"`
	Page   string  `json:"html_url"`
	Assets []asset `json:"assets"`
}

type asset struct {
	Name   string `json:"name"`
	URL    string `json:"browser_download_url"`
	Digest string `json:"digest"`
	Size   int64  `json:"size"`
}

// Updater is one program's updates.
type Updater struct {
	// OnChange is called, from any goroutine, whenever the status changed; make it no more than a redraw request.
	OnChange func()
	// Relaunch is called once a new build is in place, to quit this one: the new one has been started.
	Relaunch func()

	mu        sync.Mutex
	status    Status
	found     *release
	asset     *asset
	ready     string
	lastCheck time.Time
	checkedAt time.Time
	baseURL   string
	cancel    context.CancelFunc
}

func New() *Updater {
	u := &Updater{baseURL: "https://api.github.com"}
	u.status = Status{State: Idle, Current: Version}
	if reason := unsupportedReason(); reason != "" {
		u.status = Status{State: Unsupported, Current: Version, Reason: reason}
	}
	return u
}

// Status is the present state; it is a copy.
func (u *Updater) Status() Status {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.status
}

func (u *Updater) set(s Status) {
	s.Current = Version
	u.mu.Lock()
	u.status = s
	u.mu.Unlock()
	if u.OnChange != nil {
		u.OnChange()
	}
}

// Start checks shortly after the program opens and every half hour, and again when asked to by Recheck.
func (u *Updater) Start() {
	if u.Status().State == Unsupported {
		return
	}
	go func() {
		time.Sleep(firstCheck)
		for {
			u.Check()
			time.Sleep(checkEvery)
		}
	}()
}

// Recheck is for a window coming to the front: it checks if the last check is more than ten minutes old.
func (u *Updater) Recheck() {
	u.mu.Lock()
	old := time.Since(u.lastCheck) > recheckGap
	u.mu.Unlock()
	if old {
		go u.Check()
	}
}

// Check asks the releases what is newest. A download in progress or finished is left alone.
func (u *Updater) Check() {
	s := u.Status()
	switch {
	case s.State == Unsupported || s.State == Downloading || s.State == Ready:
		return
	case s.State == Checking && time.Since(u.checkedAt) < staleCheck:
		return
	}
	u.mu.Lock()
	u.lastCheck, u.checkedAt = time.Now(), time.Now()
	u.mu.Unlock()
	if s.State != Available {
		u.set(Status{State: Checking})
	}
	ctx, cancel := context.WithTimeout(context.Background(), checkTimout)
	defer cancel()
	rel, err := u.latest(ctx)
	if err != nil {
		u.set(Status{State: Failed, Error: err.Error()})
		return
	}
	version := strings.TrimPrefix(rel.Tag, "v")
	switch a := pick(rel.Assets); {
	case !newer(version, Version):
		u.set(Status{State: Latest})
	case a == nil:
		u.set(Status{State: Missing, Version: version, Page: rel.Page})
	default:
		u.mu.Lock()
		u.found, u.asset = rel, a
		u.mu.Unlock()
		u.set(Status{State: Available, Version: version, Page: rel.Page})
	}
}

func (u *Updater) latest(ctx context.Context) (*release, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/repos/%s/%s/releases/latest", u.baseURL, owner, repo), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "Harmony-v2")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub answered %d", res.StatusCode)
	}
	var rel release
	if err := json.NewDecoder(res.Body).Decode(&rel); err != nil {
		return nil, err
	}
	if rel.Tag == "" {
		return nil, errors.New("the release has no version")
	}
	return &rel, nil
}

// Page is the page to open for the release found, or the newest release when none is known.
func (u *Updater) Page() string {
	if p := u.Status().Page; p != "" {
		return p
	}
	return fmt.Sprintf("https://github.com/%s/%s/releases/latest", owner, repo)
}

// Remove clears the old copy a Windows update leaves beside the program; call it at start.
func Remove() {
	if exe, err := os.Executable(); err == nil {
		_ = os.Remove(exe + ".old")
	}
}
