package chat

import (
	"bytes"
	"context"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"harmony/v2/internal/hclient"
)

const (
	headBytes     = 64 << 10
	headMaxFile   = 2 << 20
	headMaxLines  = 400
	headLineChars = 400
)

// Head is the start of a text file: what a message shows of it before it is opened.
type Head struct {
	Lines     []string
	LeftLines int
	LeftBytes int64
	Binary    bool
	Ready     bool
}

// PreviewsAsText says whether the first lines of a file are worth fetching: a text file of a size that can be read in a moment.
func PreviewsAsText(name string, size int64) bool {
	if size <= 0 || size > headMaxFile {
		return false
	}
	switch strings.ToLower(strings.TrimPrefix(filepath.Ext(name), ".")) {
	case "txt", "md", "log", "ini", "cfg", "csv", "tsv",
		"js", "mjs", "ts", "tsx", "jsx", "json", "html", "css", "xml", "yml", "yaml", "toml", "py", "rb", "go", "rs", "java",
		"c", "h", "cpp", "hpp", "cs", "php", "sh", "bat", "ps1", "sql", "lua", "kt", "swift":
		return true
	}
	return false
}

// Head returns the start of a text file, fetching it the first time it is asked for.
func (s *Store) Head(hash string, size int64) Head {
	s.mu.Lock()
	defer s.mu.Unlock()
	if h, ok := s.heads[hash]; ok {
		return *h
	}
	h := &Head{}
	s.heads[hash] = h
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		data, err := s.client.Download(ctx, hash, headBytes)
		s.mu.Lock()
		if err != nil || bytes.IndexByte(data, 0) >= 0 {
			*h = Head{Binary: true, Ready: true}
		} else {
			*h = excerpt(data, size)
		}
		s.mu.Unlock()
		s.changed()
	}()
	return Head{}
}

// Excerpt is the start of a text file already in hand.
func Excerpt(data []byte, size int64) Head { return excerpt(data, size) }

func excerpt(data []byte, size int64) Head {
	text := strings.ToValidUTF8(string(data), "�")
	lines := strings.Split(strings.NewReplacer("\r\n", "\n", "\r", "\n").Replace(text), "\n")
	cut := int64(len(data)) < size
	if cut && len(lines) > 1 {
		lines = lines[:len(lines)-1]
	}
	if !cut && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	shown := lines[:min(len(lines), headMaxLines)]
	out := make([]string, len(shown))
	for i, l := range shown {
		if utf8.RuneCountInString(l) > headLineChars {
			l = string([]rune(l)[:headLineChars]) + "…"
		}
		out[i] = strings.ReplaceAll(l, "\t", "    ")
	}
	h := Head{Lines: out, Ready: true}
	if hidden := len(lines) - len(shown); !cut && hidden > 0 {
		h.LeftLines = hidden
	} else if cut {
		used := int64(len(strings.Join(shown, "\n")))
		h.LeftBytes = max(0, size-used)
	}
	return h
}

// Bytes fetches a stored file whole.
func (s *Store) Bytes(hash string) func() ([]byte, error) {
	return func() ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		return s.client.Download(ctx, hash, 0)
	}
}

// Save writes a stored file into the downloads folder and returns where it went.
func (s *Store) Save(hash, name string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	data, err := s.client.Download(ctx, hash, 0)
	if err != nil {
		return "", err
	}
	return SaveFile(name, hash, data)
}

// SaveFile writes data into the downloads folder under name (made unique) and returns where it went.
func SaveFile(name, hash string, data []byte) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, "Downloads")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	name = filepath.Base(strings.NewReplacer("/", "_", "\\", "_").Replace(name))
	if name == "." || name == "" {
		name = hash[:min(12, len(hash))]
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	path := filepath.Join(dir, name)
	for n := 1; ; n++ {
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			_, err = file.Write(data)
			file.Close()
			return path, err
		}
		if !os.IsExist(err) {
			return "", err
		}
		path = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", stem, n, ext))
	}
}

// Sending is a message on its way, with its files: what the box shows while they go up.
type Sending struct {
	Name  atomic.Value
	Sent  atomic.Int64
	Total atomic.Int64
	Done  atomic.Bool
	Err   atomic.Value
}

// SendFiles uploads files one after the other and posts them, the words going with the last; progress is read from the returned value.
func (s *Store) SendFiles(channel int, body string, paths []string, replyTo int) *Sending {
	op := &Sending{}
	var total int64
	for _, p := range paths {
		if info, err := os.Stat(p); err == nil {
			total += info.Size()
		}
	}
	op.Total.Store(total)
	go func() {
		defer func() { op.Done.Store(true); s.changed() }()
		ctx := context.Background()
		var base int64
		for i, path := range paths {
			words, reply := "", 0
			if i == len(paths)-1 {
				words, reply = body, replyTo
			}
			if err := s.sendOne(ctx, channel, path, words, reply, op, &base); err != nil {
				op.Err.Store(err)
				return
			}
		}
	}()
	return op
}

func (s *Store) sendOne(ctx context.Context, channel int, path, body string, replyTo int, op *Sending, base *int64) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	name := filepath.Base(path)
	op.Name.Store(name)
	kind := strings.SplitN(mime.TypeByExtension(strings.ToLower(filepath.Ext(name))), ";", 2)[0]
	if kind == "" {
		kind = "application/octet-stream"
	}
	hash, err := s.client.Upload(ctx, file, info.Size(), kind, func(sent int64) { op.Sent.Store(*base + sent); s.changed() })
	if err != nil {
		return err
	}
	*base += info.Size()
	return s.Send(ctx, channel, hclient.Post{Body: body, AttachmentHash: hash, AttachmentName: name, ReplyTo: replyTo})
}

// PeekHead is Head without starting a fetch.
func (s *Store) PeekHead(hash string) (Head, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if h, ok := s.heads[hash]; ok {
		return *h, true
	}
	return Head{}, false
}
