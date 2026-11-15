package channels

import (
	"os"
	"path/filepath"
	"strconv"
	"time"
	"unicode/utf16"

	"harmony/v2/internal/clipboard"
)

const (
	pasteAsFileChars = 4000
	pasteTrivial     = 1000
	pasteKeep        = 24 * time.Hour
)

// pastedFiles is where what is pasted as a file is kept until it is sent.
type pastedFiles struct {
	dir   string
	swept bool
}

func utf16Len(runes []rune) int {
	n := 0
	for _, r := range runes {
		n += utf16.RuneLen(r)
	}
	return n
}

// hugePaste is whether a paste is too long to be a message: more than a message can hold, or, from a thousand characters on, more than the room left in the box.
func hugePaste(text []rune, boxLength, selected, limit int) bool {
	n := utf16Len(text)
	if n > pasteAsFileChars {
		return true
	}
	if n < pasteTrivial {
		return false
	}
	if limit <= 0 {
		limit = pasteAsFileChars
	}
	return boxLength-selected+n > limit
}

// pastedName is message.txt, or message (2).txt and so on when a file going with the same message has that name.
func pastedName(taken []string) string {
	used := map[string]bool{}
	for _, name := range taken {
		used[name] = true
	}
	if !used["message.txt"] {
		return "message.txt"
	}
	for n := 2; ; n++ {
		if name := "message (" + strconv.Itoa(n) + ").txt"; !used[name] {
			return name
		}
	}
}

func (s *Screen) pasteFolder() string {
	p := &s.chat.pasted
	if p.dir == "" {
		p.dir = filepath.Join(os.TempDir(), "harmony-v2-paste")
	}
	_ = os.MkdirAll(p.dir, 0o700)
	if !p.swept {
		p.swept = true
		if entries, err := os.ReadDir(p.dir); err == nil {
			for _, e := range entries {
				if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > pasteKeep {
					_ = os.RemoveAll(filepath.Join(p.dir, e.Name()))
				}
			}
		}
	}
	return p.dir
}

// keepPasted writes data under name in a folder of its own and attaches it to the message.
func (s *Screen) keepPasted(name string, data []byte) bool {
	dir, err := os.MkdirTemp(s.pasteFolder(), "p")
	if err != nil {
		return false
	}
	path := filepath.Join(dir, name)
	if os.WriteFile(path, data, 0o600) != nil {
		return false
	}
	s.chat.files = append(s.chat.files, path)
	return true
}

func (s *Screen) pendingNames() []string {
	names := make([]string, len(s.chat.files))
	for i, f := range s.chat.files {
		names[i] = filepath.Base(f)
	}
	return names
}

// pasteClipboard is what pasting into the box does beyond text: files copied in the file manager and pictures become attachments, and a text too long for a message becomes message.txt. It returns true when it took the paste.
func (s *Screen) pasteClipboard(text string) bool {
	st := &s.chat
	if files := clipboard.Files(); len(files) > 0 {
		for _, f := range files {
			if info, err := os.Stat(f); err == nil && !info.IsDir() {
				st.files = append(st.files, f)
			}
		}
		return true
	}
	if text == "" {
		img := clipboard.Image()
		if img == nil {
			return false
		}
		return s.keepPasted("pasted-"+time.Now().UTC().Format("20060102T150405")+".png", img)
	}
	runes := []rune(text)
	if !hugePaste(runes, utf16Len(st.input.Runes()), utf16Len(st.input.SelectedRunes()), st.input.MaxLength) {
		return false
	}
	return s.keepPasted(pastedName(s.pendingNames()), []byte(text))
}
