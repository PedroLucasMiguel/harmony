package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"harmony/v2/internal/clip"
	"harmony/v2/internal/hclient"
)

const (
	maxClipFile    = 25 << 20
	maxClipGain    = 3.5
	clipTimeout    = 30 * time.Second
	defaultPercent = 100
)

var clipTypes = map[string]string{
	".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".webm": "audio/webm",
}

// soundboard is the server's clips, who may manage them, and how loud they play here.
type soundboard struct {
	clips   atomic.Pointer[[]hclient.Clip]
	percent atomic.Int32
	admin   bool
	fetch   sync.Mutex
}

func (s *Session) startSoundboard(admin bool) {
	s.sound.admin = admin
	s.sound.percent.Store(defaultPercent)
	go s.loadClips()
}

// Clips is the soundpad as the server last listed it; the slice is never changed, only replaced.
func (s *Session) Clips() []hclient.Clip {
	if list := s.sound.clips.Load(); list != nil {
		return *list
	}
	return nil
}

// IsAdmin is whether the person may stop the soundpad for everybody and add clips.
func (s *Session) IsAdmin() bool { return s.sound.admin }

// SetClipVolume is how loud clips play for this person, in percent of the recording.
func (s *Session) SetClipVolume(percent int) { s.sound.percent.Store(int32(percent)) }

func (s *Session) clipGain() float64 {
	return min(max(float64(s.sound.percent.Load())/100, 0), maxClipGain)
}

// PlayClip asks the server to play a clip for everybody in the channel, this person included.
func (s *Session) PlayClip(id int) error {
	_, channelID, ok := s.tokens()
	if !ok {
		return ErrNotInVoice
	}
	ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
	defer cancel()
	_, err := s.rt.Request(ctx, "soundpad:play", map[string]any{"channelId": channelID, "clipId": id})
	return err
}

// StopClips silences the clips here at once and, as an admin, in the whole channel.
func (s *Session) StopClips() error {
	s.mixer.StopClips()
	_, channelID, ok := s.tokens()
	if !ok {
		return nil
	}
	ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
	defer cancel()
	_, err := s.rt.Request(ctx, "soundpad:stop", map[string]any{"channelId": channelID})
	return err
}

// AddClip uploads an audio file and puts it in the soundpad under a name.
func (s *Session) AddClip(path, name, emoji string) error {
	contentType, ok := clipTypes[strings.ToLower(filepath.Ext(path))]
	if !ok {
		return errors.New("choose an mp3, wav, ogg or webm file")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(s.ctx, 2*clipTimeout)
	defer cancel()
	hash, err := s.client.Upload(ctx, file, info.Size(), contentType, nil)
	if err != nil {
		return err
	}
	return s.client.AddClip(ctx, name, emoji, hash)
}

// RenameClip changes a clip's name and emoji for everybody; the list comes back through the realtime event.
func (s *Session) RenameClip(id int, name, emoji string) error {
	ctx, cancel := context.WithTimeout(s.ctx, clipTimeout)
	defer cancel()
	return s.client.RenameClip(ctx, id, name, emoji)
}

func (s *Session) DeleteClip(id int) error {
	ctx, cancel := context.WithTimeout(s.ctx, clipTimeout)
	defer cancel()
	return s.client.DeleteClip(ctx, id)
}

// MoveClip moves a clip one place along the soundpad, the whole order being sent as the server wants it.
func (s *Session) MoveClip(id, delta int) error {
	clips := s.Clips()
	from := slices.IndexFunc(clips, func(c hclient.Clip) bool { return c.ID == id })
	to := from + delta
	if from < 0 || to < 0 || to >= len(clips) {
		return nil
	}
	ids := make([]int, len(clips))
	for i, c := range clips {
		ids[i] = c.ID
	}
	ids[from], ids[to] = ids[to], ids[from]
	ctx, cancel := context.WithTimeout(s.ctx, clipTimeout)
	defer cancel()
	return s.client.ReorderClips(ctx, ids)
}

func (s *Session) loadClips() {
	ctx, cancel := context.WithTimeout(s.ctx, clipTimeout)
	defer cancel()
	clips, err := s.client.Clips(ctx)
	if err != nil {
		s.logf("could not load the soundpad: %v", err)
		return
	}
	s.setClips(clips)
}

func (s *Session) setClips(clips []hclient.Clip) {
	s.sound.clips.Store(&clips)
	s.changed()
	for _, c := range clips {
		if path, ok := clipPath(c.Hash); ok {
			if _, err := os.Stat(path); err == nil {
				continue
			}
		}
		if _, err := s.clipFile(c.Hash); err != nil {
			s.logf("could not fetch the clip %q: %v", c.Name, err)
		}
	}
}

func (s *Session) soundEvent(msg hclient.Message) {
	switch msg.Type {
	case "soundpad":
		var m struct {
			Clips []hclient.Clip `json:"clips"`
		}
		if msg.Decode(&m) == nil {
			go s.setClips(m.Clips)
		}
	case "soundpad:play":
		var m struct {
			ChannelID int    `json:"channelId"`
			Hash      string `json:"hash"`
			Name      string `json:"name"`
		}
		if msg.Decode(&m) != nil {
			return
		}
		s.mu.Lock()
		audible := s.joined != nil && s.joined.ChannelID == m.ChannelID && !s.deafened
		s.mu.Unlock()
		if audible {
			go s.playHash(m.Hash, m.Name)
		}
	case "soundpad:stop":
		s.mixer.StopClips()
	}
}

func (s *Session) playHash(hash, name string) {
	data, err := s.clipFile(hash)
	if err == nil {
		var pcm []int16
		if pcm, err = clip.Decode(data); err == nil {
			s.mixer.PlayClip(pcm, s.clipGain())
			return
		}
	}
	s.logf("could not play %q: %v", name, err)
}

// clipPath is where a clip is kept on disk; ok is false for a name that is not a hash or when there is no cache directory.
func clipPath(hash string) (path string, ok bool) {
	dir, err := os.UserCacheDir()
	if err != nil || !isHash(hash) {
		return "", false
	}
	return filepath.Join(dir, "Harmony v2", "clips", hash), true
}

// clipFile is a clip's bytes from the cache on disk, fetched from the server the first time.
func (s *Session) clipFile(hash string) ([]byte, error) {
	if !isHash(hash) {
		return nil, fmt.Errorf("bad file name %q", hash)
	}
	path, cached := clipPath(hash)
	if !cached {
		return s.downloadClip(hash)
	}
	if data, err := os.ReadFile(path); err == nil {
		return data, nil
	}
	s.sound.fetch.Lock()
	defer s.sound.fetch.Unlock()
	if data, err := os.ReadFile(path); err == nil {
		return data, nil
	}
	data, err := s.downloadClip(hash)
	if err == nil && os.MkdirAll(filepath.Dir(path), 0o755) == nil {
		_ = os.WriteFile(path, data, 0o600)
	}
	return data, err
}

func (s *Session) downloadClip(hash string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(s.ctx, clipTimeout)
	defer cancel()
	return s.client.Download(ctx, hash, maxClipFile)
}

func isHash(s string) bool {
	if len(s) < 16 || len(s) > 128 {
		return false
	}
	for _, r := range s {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}
