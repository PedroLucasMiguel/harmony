package chat

import (
	"bytes"
	"context"
	"image"
	"image/draw"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"harmony/v2/internal/hclient"
)

// Emoji is one of the server's own pictures.
type Emoji struct {
	hclient.CustomEmoji
	// Fetch downloads the picture; it is made once so that drawing does not allocate.
	Fetch func() ([]byte, error)
}

// EmojiSet is the server's custom emoji as of one moment. It is never changed: a new list is a new set.
type EmojiSet struct {
	List   []*Emoji
	byName map[string]*Emoji
}

// Find returns the emoji with a name (lower case, without colons), or nil.
func (e *EmojiSet) Find(name string) *Emoji {
	if e == nil {
		return nil
	}
	return e.byName[name]
}

func (s *Store) setEmojis(list []hclient.CustomEmoji) {
	set := &EmojiSet{List: make([]*Emoji, len(list)), byName: make(map[string]*Emoji, len(list))}
	for i, c := range list {
		e := &Emoji{CustomEmoji: c, Fetch: s.Bytes(c.Hash)}
		set.List[i], set.byName[c.Name] = e, e
	}
	s.emojis.Store(set)
	s.changed()
}

// Emojis is the server's custom emoji; the set is replaced whenever they change.
func (s *Store) Emojis() *EmojiSet { return s.emojis.Load() }

func (s *Store) loadEmojis() {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if list, err := s.client.Emojis(ctx); err == nil {
		s.setEmojis(list)
	}
}

// React puts the person's reaction on a message or takes it back; the server's answer reaches everyone, the person included, as an event.
func (s *Store) React(ctx context.Context, id int, emoji string, on bool) error {
	return s.client.React(ctx, id, emoji, on)
}

func (s *Store) setReactions(channel, id int, reactions []hclient.Reaction) {
	s.mu.Lock()
	f := s.holder(channel, id)
	if f == nil {
		s.mu.Unlock()
		return
	}
	i := slices.IndexFunc(f.entries, func(e *Entry) bool { return e.Msg.ID == id })
	if i < 0 {
		s.mu.Unlock()
		return
	}
	entries := slices.Clone(f.entries)
	old := entries[i]
	entry := &Entry{Msg: old.Msg, Layout: old.Layout}
	entry.Msg.Reactions = reactions
	entries[i] = entry
	f.entries = entries
	s.mu.Unlock()
	s.changed()
}

// AddEmoji uploads a picture and registers it as a custom emoji called name.
func (s *Store) AddEmoji(ctx context.Context, name string, picture []byte) error {
	hash, err := s.client.Upload(ctx, bytes.NewReader(picture), int64(len(picture)), "image/png", nil)
	if err != nil {
		return err
	}
	return s.client.AddEmoji(ctx, name, hash)
}

func (s *Store) DeleteEmoji(ctx context.Context, id int) error { return s.client.DeleteEmoji(ctx, id) }

const emojiEdge = 128

// EmojiPicture reads an image file and shrinks it to fit a custom emoji's size, as a PNG.
func EmojiPicture(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	src, _, err := image.Decode(file)
	if err != nil {
		return nil, err
	}
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	if long := max(w, h); long > emojiEdge {
		w, h = max(1, w*emojiEdge/long), max(1, h*emojiEdge/long)
	}
	out := image.NewNRGBA(image.Rect(0, 0, w, h))
	xdraw.ApproxBiLinear.Scale(out, out.Bounds(), src, src.Bounds(), draw.Src, nil)
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, out); err != nil {
		return nil, err
	}
	return encoded.Bytes(), nil
}

// EmojiName suggests a name for an emoji from the name of its file.
func EmojiName(path string) string {
	base := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	var b strings.Builder
	for _, r := range strings.ToLower(base) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_' {
			b.WriteRune(r)
		} else if b.Len() > 0 && !strings.HasSuffix(b.String(), "_") {
			b.WriteByte('_')
		}
	}
	return strings.Trim(b.String()[:min(b.Len(), 32)], "_")
}
