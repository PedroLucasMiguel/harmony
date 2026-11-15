package channels

import (
	"os"
	"path/filepath"
	"strings"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/chat"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

func isVideo(e *chat.Entry) bool { return e.Msg.MediaType == "video" }

// videoRoom is the width the play button of a video takes beside its name.
func videoRoom(e *chat.Entry) float32 {
	if isVideo(e) {
		return attachButtonW + toolGap
	}
	return 0
}

// playButton opens a video in the computer's own player.
func (s *Screen) playButton(c *widget.Context, e *chat.Entry, r geom.Rect) {
	if !isVideo(e) {
		return
	}
	if c.Hovered(r) {
		c.SetCursor(rl.MouseCursorPointingHand)
		c.Paint.Fill(r, 5, theme.WithAlpha(c.Theme.Tint, 0.12))
		if c.Clicked(r) {
			c.Claim()
			s.playVideo(e.Msg.AttachmentHash, e.Msg.AttachmentName)
		}
	}
	c.Paint.Icon("play", geom.Rect{X: r.X + (r.W-attachIcon)/2, Y: r.Y + (r.H-attachIcon)/2, W: attachIcon, H: attachIcon}, c.Theme.Accent)
}

// playVideo fetches a video into the temporary folder once and hands it to the system's player.
func (s *Screen) playVideo(hash, name string) {
	fetch := s.chatFeed().Bytes(hash)
	go func() {
		dir := filepath.Join(os.TempDir(), "harmony-v2-media")
		path := filepath.Join(dir, hash[:min(16, len(hash))]+"-"+strings.NewReplacer("/", "_", "\\", "_").Replace(filepath.Base(name)))
		if _, err := os.Stat(path); err != nil {
			data, err := fetch()
			if err != nil {
				s.fail(err)
				return
			}
			if err := os.MkdirAll(dir, 0o700); err != nil {
				s.fail(err)
				return
			}
			if err := os.WriteFile(path, data, 0o600); err != nil {
				s.fail(err)
				return
			}
		}
		rl.OpenURL(fileURL(path))
	}()
}

func fileURL(path string) string {
	path = filepath.ToSlash(path)
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return "file://" + path
}
