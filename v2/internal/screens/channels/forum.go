package channels

import (
	"harmony/v2/internal/chat"
	"harmony/v2/internal/i18n"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
)

const (
	forumListMin   = 224
	forumListMax   = 352
	forumListShare = 0.30
	forumGap       = 16
	forumNarrow    = 720
)

// forumState is the forum on show: its list of posts, the card a post is started in, and the post that is open beside them.
type forumState struct {
	channel int
	post    int
	title   string
	author  int

	filter  chat.PostFilter
	list    postList
	compose composeCard

	titleLines  titleMemo
	searchHint  string
	hintFor     *i18n.Bundle
	placeholder string
}

func (s *Screen) forumOpen() bool { return s.forum.channel != 0 }

// openForum shows a forum's list; picking the forum that is already open leaves its post, as Electron does.
func (s *Screen) openForum(id int) {
	f := &s.forum
	if f.channel == id {
		s.closePost()
		return
	}
	s.closeText()
	s.finishDM()
	*f = forumState{channel: id, filter: chat.PostFilter{Sort: "new"}}
	f.list.reset()
	s.Session.Chat().OpenForum(id, f.filter)
	redraw.Request()
}

// finishDM leaves the page of private messages the forum is opened from.
func (s *Screen) finishDM() {
	if s.dm.page {
		s.dm.back = 0
		s.leavePrivate()
	}
}

// leaveForum puts the forum away, and the post that was open in it.
func (s *Screen) leaveForum() {
	f := &s.forum
	if f.channel == 0 {
		return
	}
	s.closePost()
	store := s.Session.Chat()
	store.CloseForum(f.channel)
	store.ForgetForumRead(f.channel)
	store.SetOpen(0)
	f.compose.close()
	*f = forumState{}
	redraw.Request()
}

// openPost shows a post's thread beside the list.
func (s *Screen) openPost(id int) {
	f, st := &s.forum, &s.chat
	if f.channel == 0 || f.post == id {
		return
	}
	s.closePost()
	store := s.Session.Chat()
	key := store.OpenThread(f.channel, id)
	f.post, f.title, f.placeholder = id, "", ""
	s.cancelRecording()
	st.dm, st.channel, st.offset, st.lastID = false, key, 0, 0
	st.reply, st.editing, st.files = nil, nil, nil
	st.input.Clear()
	st.input.RequestFocus()
	s.openNews(key)
	redraw.Request()
}

// closePost puts the open post away; the list is the whole forum again.
func (s *Screen) closePost() {
	f, st := &s.forum, &s.chat
	if f.post == 0 {
		return
	}
	s.cancelRecording()
	s.Session.Chat().CloseThread(st.channel)
	s.Session.Chat().SetOpen(f.channel)
	st.channel, st.reply, st.editing, st.files = 0, nil, nil, nil
	st.find.search.clearAll()
	st.find.pins.sheet.Close()
	st.find.stars.sheet.Close()
	f.post = 0
	redraw.Request()
}

func (s *Screen) drawForum(c *widget.Context, r geom.Rect, m model) {
	f := &s.forum
	s.chat.find.c = c
	if f.post != 0 {
		s.followPost(c)
	}
	narrow := c.Viewport.W <= forumNarrow
	switch {
	case f.post == 0:
		s.drawPostList(c, r, m, false)
	case narrow:
		s.drawChat(c, r, m)
	default:
		listW := min(max(forumListShare*r.W, forumListMin), forumListMax)
		if *s.widthSetting(colForum) != 0 {
			listW, _ = s.columnWidth(colForum, r.W)
		}
		s.drawPostList(c, geom.Rect{X: r.X, Y: r.Y, W: listW, H: r.H}, m, true)
		edge := c.Hairline()
		line := r.X + listW + forumGap
		c.Paint.Fill(geom.Rect{X: line, Y: r.Y, W: edge, H: r.H}, 0, c.Theme.Border)
		s.dragHandle(c, colForum, geom.Rect{X: r.X + listW - handleInside, Y: r.Y, W: handleInside + 2*forumGap + edge, H: r.H}, line-1, 1, listW, r.W)
		x := line + edge + forumGap
		s.drawChat(c, geom.Rect{X: x, Y: r.Y, W: r.Right() - x, H: r.H}, m)
	}
	if f.post == 0 {
		s.takeForumDrops(c)
		s.showReactionLayers(c, m)
	}
}

// takeForumDrops starts a post with the files dropped on the list.
func (s *Screen) takeForumDrops(c *widget.Context) {
	if len(c.In.Dropped) == 0 {
		return
	}
	k := &s.forum.compose
	k.open(s, "")
	k.add(c.In.Dropped, c)
}

// followPost learns the open post's title as its thread arrives, and leaves a post the server says is gone.
func (s *Screen) followPost(c *widget.Context) {
	f := &s.forum
	post, ok, gone := s.Session.Chat().Thread(s.chat.channel)
	if gone {
		s.closePost()
		s.say(c.T("forum.post_gone"))
		return
	}
	if ok && f.title != post.Title {
		f.title, f.author = post.Title, post.UserID
		f.placeholder = c.T("forum.reply_placeholder", "title", post.Title)
	}
	if f.hintFor != c.Strings {
		f.hintFor, f.searchHint = c.Strings, c.T("forum.search_post")
	}
}

type titleMemo struct {
	text        string
	width, zoom float32
	lines       []string
}
