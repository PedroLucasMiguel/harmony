package channels

import (
	"context"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/filedialog"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/widget"
)

const replaceTimeout = 10 * time.Minute

// mayDeleteMessage tells whether this person may delete somebody else's message in a channel: those with the permission may.
func (s *Screen) mayDeleteMessage(m model, msg *hclient.ChatMessage) bool {
	return !s.chat.dm && msg.Title == "" && m.state.Actor.Can("messages.delete")
}

// askDelete asks before a message is deleted.
func (s *Screen) askDelete(id int) {
	c := s.chat.pick.c
	if c == nil {
		return
	}
	feed := s.chatFeed()
	s.confirm(c, c.T("app.delete_this_message"), "", c.T("app.delete_2"), func() {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			s.fail(feed.Delete(ctx, id))
		}()
	})
}

// messageMenu opens the menu of a message at the pointer: copy what is selected, open or copy a link under the pointer, copy the message's words.
func (s *Screen) messageMenu(c *widget.Context, r *row) {
	menu := &s.chat.menu
	var items []widget.MenuItem
	text := rowText(r)
	if text != nil && s.chat.pick.sel.Active() {
		if from, to := s.chat.pick.sel.Range(r.entry.Msg.ID, 1<<30); from < to {
			plain := text.Plain(c)
			picked := string(plain[from:min(to, len(plain))])
			if strings.TrimSpace(picked) != "" {
				items = append(items, widget.MenuItem{Icon: "copy", Label: c.T("chat_menu.copy"), OnPick: func() { rl.SetClipboardText(picked) }})
			}
		}
	}
	if text != nil {
		if link := text.LinkAt(c.In.MouseX, c.In.MouseY); link != "" {
			items = append(items,
				widget.MenuItem{Icon: "arrow-square-out", Label: c.T("chat_menu.open_link"), OnPick: func() { rl.OpenURL(link) }},
				widget.MenuItem{Icon: "copy", Label: c.T("chat_menu.copy_link"), OnPick: func() { rl.SetClipboardText(link) }})
		}
	}
	if body := r.entry.Msg.Body; strings.TrimSpace(body) != "" {
		items = append(items, widget.MenuItem{Icon: "copy", Label: c.T("chat_menu.copy_message"), OnPick: func() { rl.SetClipboardText(body) }})
	}
	if len(items) == 0 {
		return
	}
	menu.Head, menu.NameOnly, menu.Items = c.T("app.message"), true, items
	menu.OpenAt(c.In.MouseX, c.In.MouseY)
}

func contentType(name string) string {
	if t := mime.TypeByExtension(strings.ToLower(filepath.Ext(name))); t != "" {
		return t
	}
	return "application/octet-stream"
}

// replaceFile lets the person choose another file for one of their messages and swaps it in.
func (s *Screen) replaceFile(c *widget.Context, id int) {
	if s.chat.picking {
		return
	}
	s.chat.picking = true
	client := s.Session.Client()
	go func() {
		files := filedialog.Pick(c.T("app.replace_this_file"))
		c.Post(func() { s.chat.picking = false })
		if len(files) == 0 {
			return
		}
		path := files[0]
		f, err := os.Open(path)
		if err != nil {
			s.fail(err)
			return
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil || info.IsDir() {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), replaceTimeout)
		defer cancel()
		name := filepath.Base(path)
		hash, err := client.Upload(ctx, f, info.Size(), contentType(name), nil)
		if err == nil {
			err = client.SetAttachment(ctx, id, hash, name)
		}
		s.fail(err)
	}()
}
