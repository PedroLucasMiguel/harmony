package channels

import (
	"strings"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/chat"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	forumSearchDelay = 250 * time.Millisecond
	forumToolbarTop  = 9.6
	forumToolbarGap  = 10
	forumToolbarBot  = 12.8
	forumSearchH     = 51.7
	forumSearchPadL  = 11.2
	forumSearchPadR  = 7.3
	forumSearchGap   = 8
	forumSearchIcon  = 16.3
	forumSearchIconA = 0.55
	forumInputPad    = 12
	forumFilterGap   = 8
	forumFilterIcon  = 15.5
	forumEmptyPad    = 32
	forumMoreTop     = 12.8
	forumMoreBottom  = 6.4
)

var forumSorts = [...]string{"activity", "new", "replies"}

// postList is the forum's list as one component: its search box, the filters, and the posts under them.
type postList struct {
	search   widget.TextField
	newPost  widget.Button
	sort     widget.Button
	mentions widget.Button
	more     widget.Button
	create   widget.Button
	menu     widget.ContextMenu
	scroll   widget.Scroll
	col      postColumn

	layouts  map[int]*postLayout
	typed    string
	changed  time.Time
	pending  bool
	wired    bool
	menuSort string
	menuFor  any
	view     geom.Rect
	failed   error
}

func (l *postList) reset() {
	l.layouts = nil
	l.search.SetValue("")
	l.typed, l.pending, l.menuSort = "", false, ""
	l.mentions.Active = false
}

func (s *Screen) wirePostList(c *widget.Context) {
	l := &s.forum.list
	if l.wired {
		return
	}
	l.wired = true
	l.search.Bare, l.search.Style = true, paint.TextStyle{Size: 14, Weight: paint.Regular}
	l.newPost = widget.Button{Icon: "chats-teardrop", IconSize: 16.4, IconGap: 6.4, Variant: widget.Primary, OnClick: func() { s.forum.compose.open(s, "") }}
	l.sort = widget.Button{Icon: "arrows-down-up", IconSize: forumFilterIcon, Variant: widget.Ghost, Small: true, OnClick: func() {
		l.menu.OpenBelow(l.col.sortAt)
	}}
	l.mentions = widget.Button{Icon: "at", IconSize: forumFilterIcon, Variant: widget.Ghost, Small: true, OnClick: func() {
		f := &s.forum
		l.mentions.Active = !l.mentions.Active
		f.filter.Mentions = l.mentions.Active
		s.applyFilter()
	}}
	l.more = widget.Button{Variant: widget.Ghost, Small: true, OnClick: func() { s.Session.Chat().MorePosts(s.forum.channel) }}
	l.create = widget.Button{Variant: widget.Ghost, Small: true, OnClick: func() { s.forum.compose.open(s, l.search.Value) }}
	l.scroll.Bar, l.scroll.Overlay = true, true
	l.col.s = s
}

func (s *Screen) applyFilter() {
	f := &s.forum
	f.list.layouts = nil
	f.list.scroll = widget.Scroll{Bar: true, Overlay: true}
	s.Session.Chat().Filter(f.channel, f.filter)
}

// followSearch sends what is typed once the keys have been quiet for a moment.
func (s *Screen) followSearch(c *widget.Context) {
	f := &s.forum
	l := &f.list
	if c.EscapeBase() && l.search.Focused(c) && l.search.Value != "" {
		l.search.SetValue("")
		c.In.Escape = false
	}
	if l.search.Value != l.typed {
		l.typed, l.changed, l.pending = l.search.Value, time.Now(), true
	}
	if !l.pending {
		return
	}
	if wait := forumSearchDelay - time.Since(l.changed); wait > 0 {
		redraw.After(wait)
		return
	}
	l.pending = false
	text := strings.TrimSpace(l.typed)
	if text == f.filter.Text {
		return
	}
	f.filter.Text = text
	s.applyFilter()
}

func (s *Screen) drawPostList(c *widget.Context, r geom.Rect, m model, compact bool) {
	f := &s.forum
	l := &f.list
	s.wirePostList(c)
	store := s.Session.Chat()
	posts := store.Forum(f.channel)
	l.newPost.Label = c.T("forum.new_post")
	if compact {
		l.newPost.Label, l.newPost.Small = "", true
	} else {
		l.newPost.Small = false
	}
	l.sort.Label = c.T("forum.sort")
	l.mentions.Label = c.T("forum.mentions")
	l.more.Label = c.T("forum.more")
	l.more.Disabled = posts.Loading
	s.followSearch(c)

	name := s.channelNamed(m, f.channel)
	widget.Heading{Title: name}.Draw(c, geom.Rect{X: r.X, Y: r.Y, W: r.W, H: channelHeadH})
	y := r.Y + channelHeadH + forumToolbarTop
	y += s.drawForumSearch(c, geom.Rect{X: r.X, Y: y, W: r.W, H: forumSearchH}) + forumToolbarGap
	y += s.drawForumFilters(c, geom.Rect{X: r.X, Y: y, W: r.W}) + forumToolbarBot
	y += f.compose.draw(c, s, geom.Rect{X: r.X, Y: y, W: r.W})

	view := geom.Rect{X: r.X, Y: y, W: r.W, H: max(0, r.Bottom()-y)}
	l.view = view
	l.col.use(c, m, posts)
	l.scroll.Child = &l.col
	l.scroll.Draw(c, view)
	if posts.Err != nil && posts.Err != l.failed {
		l.failed = posts.Err
		s.fail(posts.Err)
	}
	if len(posts.Posts) > 0 {
		redraw.After(agoRefresh)
	}
	l.menu.Show(c)
}

func (s *Screen) drawForumSearch(c *widget.Context, r geom.Rect) float32 {
	l := &s.forum.list
	edge := c.Hairline()
	border := c.Theme.Border
	if l.search.Focused(c) {
		border = c.Theme.Accent
	}
	c.Paint.Fill(r, postRadius, c.Theme.Surface2)
	c.Paint.Stroke(r, postRadius, edge, border)
	c.Paint.Icon("magnifying-glass", geom.Rect{X: r.X + forumSearchPadL, Y: r.Y + (r.H-forumSearchIcon)/2, W: forumSearchIcon, H: forumSearchIcon}, theme.WithAlpha(c.Theme.Text, forumSearchIconA))
	size := l.newPost.Measure(c, 0)
	btn := geom.Rect{X: r.Right() - forumSearchPadR - size.W, Y: r.Y + (r.H-size.H)/2, W: size.W, H: size.H}
	l.newPost.Draw(c, btn)
	x := r.X + forumSearchPadL + forumSearchIcon + forumSearchGap + forumInputPad
	l.search.Placeholder = c.T("forum.search_placeholder")
	line := float32(21)
	l.search.Draw(c, geom.Rect{X: x, Y: r.Y + (r.H-line)/2, W: max(0, btn.X-forumSearchGap-x), H: line})
	if c.Hovered(r) && c.Clicked(r) && !c.Hovered(btn) {
		c.Claim()
		l.search.RequestFocus()
	}
	return r.H
}

func (s *Screen) drawForumFilters(c *widget.Context, r geom.Rect) float32 {
	f := &s.forum
	l := &f.list
	sort, mentions := l.sort.Measure(c, 0), l.mentions.Measure(c, 0)
	l.col.sortAt = geom.Rect{X: r.X, Y: r.Y, W: sort.W, H: sort.H}
	l.sort.Draw(c, l.col.sortAt)
	l.mentions.Draw(c, geom.Rect{X: r.X + sort.W + forumFilterGap, Y: r.Y, W: mentions.W, H: mentions.H})
	if l.menuSort != f.filter.Sort || l.menuFor != c.Strings {
		l.menuSort, l.menuFor = f.filter.Sort, c.Strings
		l.menu.Items = l.menu.Items[:0]
		for _, name := range forumSorts {
			item := widget.MenuItem{Label: c.T("forum.sort_" + name)}
			if name == f.filter.Sort {
				item.Icon = "check"
			}
			sort := name
			item.OnPick = func() {
				if sort != f.filter.Sort {
					f.filter.Sort = sort
					s.applyFilter()
				}
			}
			l.menu.Items = append(l.menu.Items, item)
		}
	}
	return sort.H
}

// postColumn is the posts of the list, one under the other, with what is shown when there are none and the button for more.
type postColumn struct {
	s      *Screen
	m      model
	posts  chat.PostList
	sortAt geom.Rect
	empty  string
	emptyW float32
	tops   []float32
}

func (p *postColumn) use(c *widget.Context, m model, posts chat.PostList) {
	p.m, p.posts = m, posts
}

func (p *postColumn) Measure(c *widget.Context, maxWidth float32) geom.Size {
	h := float32(0)
	p.tops = p.tops[:0]
	l := &p.s.forum.list
	for i := range p.posts.Posts {
		lay := p.s.layoutPost(c, p.m, l, &p.posts.Posts[i], maxWidth)
		p.tops = append(p.tops, h)
		h += lay.height + postGap
	}
	if len(p.posts.Posts) == 0 {
		if p.posts.Loading {
			return geom.Size{W: maxWidth}
		}
		return geom.Size{W: maxWidth, H: p.emptyHeight(c)}
	}
	h -= postGap
	if p.posts.More {
		h += forumMoreTop + p.moreSize(c).H + forumMoreBottom
	}
	return geom.Size{W: maxWidth, H: h}
}

func (p *postColumn) moreSize(c *widget.Context) geom.Size { return p.s.forum.list.more.Measure(c, 0) }

func (p *postColumn) emptyHeight(c *widget.Context) float32 {
	h := float32(2*forumEmptyPad + 14*1.5)
	if p.s.forum.filter.Text != "" {
		h += 8 + p.s.forum.list.create.Measure(c, 0).H
	}
	return h
}

func (p *postColumn) Draw(c *widget.Context, r geom.Rect) {
	s := p.s
	f := &s.forum
	l := &f.list
	if len(p.posts.Posts) == 0 {
		if !p.posts.Loading {
			s.drawNoPosts(c, r)
		}
		return
	}
	hoverOK := l.view.Contains(c.In.MouseX, c.In.MouseY)
	for i := range p.posts.Posts {
		post := &p.posts.Posts[i]
		lay := l.layouts[post.Msg.ID]
		row := geom.Rect{X: r.X, Y: r.Y + p.tops[i], W: r.W, H: lay.height}
		if row.Bottom() < l.view.Y || row.Y > l.view.Bottom() {
			continue
		}
		hovered := hoverOK && c.Hovered(row)
		s.drawPost(c, p.m, l, post, lay, row, hovered)
		if hovered {
			c.SetCursor(rl.MouseCursorPointingHand)
			var buf [2]postTool
			if s.drawPostTools(c, row, s.postTools(c, p.m, &post.Msg, buf[:0])) {
				continue
			}
			if c.Clicked(row) {
				c.Claim()
				s.openPost(post.Msg.ID)
			}
		}
	}
	if p.posts.More {
		size := p.moreSize(c)
		last := r.Y + p.tops[len(p.tops)-1] + l.layouts[p.posts.Posts[len(p.posts.Posts)-1].Msg.ID].height
		l.more.Draw(c, geom.Rect{X: r.X + (r.W-size.W)/2, Y: last + forumMoreTop, W: size.W, H: size.H})
	}
}

func (s *Screen) drawNoPosts(c *widget.Context, r geom.Rect) {
	f := &s.forum
	l := &f.list
	key := "forum.empty"
	switch {
	case f.filter.Text != "":
		key = "forum.no_match"
	case f.filter.Mentions:
		key = "forum.no_mentions"
	}
	text := c.T(key)
	style := paint.TextStyle{Size: 14, Weight: paint.Regular}
	line := float32(14 * 1.5)
	y := r.Y + forumEmptyPad
	c.Paint.Text(text, r.X+(r.W-c.Paint.TextWidth(text, style))/2, y, line, style, c.Theme.Muted)
	if f.filter.Text != "" {
		l.create.Label = c.T("forum.create_titled", "title", f.filter.Text)
		size := l.create.Measure(c, 0)
		l.create.Draw(c, geom.Rect{X: r.X + (r.W-size.W)/2, Y: y + line + 8, W: size.W, H: size.H})
	}
}
