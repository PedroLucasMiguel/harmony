package chat

import (
	"context"
	"errors"
	"math"
	"mime"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"harmony/v2/internal/hclient"
)

const (
	postsPage    = 30
	MaxPostFiles = 10
)

// Post is a line of a forum's listing.
type Post struct {
	Msg      hclient.ChatMessage
	Replies  int
	Last     int64
	Mentions int
}

// PostList is what the open forum shows: its posts in order, and whether more can be asked for. Posts is never written to again.
type PostList struct {
	Posts   []Post
	More    bool
	Loading bool
	Err     error
}

// PostFilter is what narrows and orders a forum's posts.
type PostFilter struct {
	Text     string
	Sort     string
	Mentions bool
}

type listing struct {
	filter  PostFilter
	posts   []Post
	more    bool
	loading bool
	err     error
	ticket  int
}

type forumState struct {
	lists     map[int]*listing
	threads   map[int]int
	canPin    atomic.Bool
	canDelete atomic.Bool
}

// ThreadKey is the number a post's thread goes by wherever a channel's number is taken: below zero, so no channel has it.
func ThreadKey(post int) int { return -post }

// routeKey is the feed a message belongs to: its post's thread, or its channel.
func routeKey(m hclient.ChatMessage) int {
	switch {
	case m.ThreadID != 0:
		return ThreadKey(m.ThreadID)
	case m.Title != "":
		return ThreadKey(m.ID)
	}
	return m.ChannelID
}

// SetForumRights says whether the person may pin posts and delete other people's.
func (s *Store) SetForumRights(pin, remove bool) {
	s.forum.canPin.Store(pin)
	s.forum.canDelete.Store(remove)
}

func (s *Store) CanPinPosts() bool    { return s.forum.canPin.Load() }
func (s *Store) CanDeletePosts() bool { return s.forum.canDelete.Load() }

// OpenThread makes a post's thread known and returns the number to read it by.
func (s *Store) OpenThread(forum, post int) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.forum.threads == nil {
		s.forum.threads = map[int]int{}
	}
	key := ThreadKey(post)
	s.forum.threads[key] = forum
	return key
}

// CloseThread forgets what was read of a post's thread.
func (s *Store) CloseThread(key int) {
	s.mu.Lock()
	delete(s.feeds, key)
	delete(s.forum.threads, key)
	delete(s.typing, key)
	s.pins.drop(key, 0)
	delete(s.pins.lists, key)
	s.mu.Unlock()
}

// Thread is the post a thread is of, once it has come, and whether the server says there is no such post.
func (s *Store) Thread(key int) (post hclient.ChatMessage, ok, gone bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f := s.feeds[key]
	if f == nil {
		return hclient.ChatMessage{}, false, false
	}
	if f.post != nil {
		return *f.post, true, f.gone
	}
	return hclient.ChatMessage{}, false, f.gone
}

func (s *Store) forumOf(key int) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.forum.threads[key]
}

// target is the channel a feed's messages go to and the post they go under, if any.
func (s *Store) target(key int) (channel, thread int) {
	if key >= 0 {
		return key, 0
	}
	return s.forumOf(key), -key
}

func (s *Store) page(ctx context.Context, key, before, until int) (hclient.MessagePage, error) {
	if key < 0 {
		return s.client.ThreadPage(ctx, s.forumOf(key), -key, before, until)
	}
	return s.client.Page(ctx, key, before, until)
}

func (f *feed) noteReply(reply hclient.MessagePage, err error) {
	var api *hclient.APIError
	switch {
	case err == nil && reply.Post != nil:
		f.post = reply.Post
	case errors.As(err, &api) && api.Code == "no_such_post":
		f.gone = true
	}
}

func (s *Store) sendTyping(key int, stopped bool) {
	channel, thread := s.target(key)
	if thread == 0 {
		s.rt.Typing(context.Background(), channel, stopped)
		return
	}
	s.rt.TypingIn(context.Background(), channel, thread, stopped)
}

// holder is the feed that holds a message of a channel: the channel's own, or one of its posts' threads. The lock is held.
func (s *Store) holder(channel, id int) *feed {
	if f := s.feeds[channel]; f != nil && hasID(f.entries, id) {
		return f
	}
	for key, forum := range s.forum.threads {
		if f := s.feeds[key]; forum == channel && f != nil && hasID(f.entries, id) {
			return f
		}
	}
	return s.feeds[channel]
}

// removed applies a deleted message: an answer leaves its thread, a post takes its thread and its place in the listing with it.
func (s *Store) removed(channel, id, thread int, post bool) {
	key := channel
	if thread != 0 {
		key = ThreadKey(thread)
	}
	s.remove(key, id)
	s.mu.Lock()
	if post {
		s.pins.drop(ThreadKey(id), 0)
		if f := s.feeds[ThreadKey(id)]; f != nil {
			f.gone = true
			f.loaded = false
			f.entries = nil
		}
	}
	if l := s.forum.lists[channel]; l != nil {
		l.posts = slices.Clone(l.posts)
		if post {
			l.posts = slices.DeleteFunc(l.posts, func(p Post) bool { return p.Msg.ID == id })
		} else if i := slices.IndexFunc(l.posts, func(p Post) bool { return p.Msg.ID == thread }); i >= 0 {
			l.posts[i].Replies = max(0, l.posts[i].Replies-1)
		}
	}
	s.mu.Unlock()
	s.changed()
}

// Forum is the listing of an open forum.
func (s *Store) Forum(channel int) PostList {
	s.mu.Lock()
	defer s.mu.Unlock()
	l := s.forum.lists[channel]
	if l == nil {
		return PostList{Loading: true}
	}
	return PostList{Posts: l.posts, More: l.more, Loading: l.loading, Err: l.err}
}

// OpenForum starts the listing of a forum from its top, and reads the forum: a forum is read as a whole.
func (s *Store) OpenForum(channel int, filter PostFilter) {
	s.SetOpen(channel)
	s.MarkForumRead(channel)
	s.Filter(channel, filter)
}

// CloseForum drops the listing of a forum put away.
func (s *Store) CloseForum(channel int) {
	s.mu.Lock()
	delete(s.forum.lists, channel)
	s.mu.Unlock()
}

// Filter shows a forum's posts for a new filter, from the first page.
func (s *Store) Filter(channel int, filter PostFilter) {
	s.mu.Lock()
	if s.forum.lists == nil {
		s.forum.lists = map[int]*listing{}
	}
	l := s.forum.lists[channel]
	if l == nil {
		l = &listing{}
		s.forum.lists[channel] = l
	}
	l.filter, l.posts, l.more, l.err = filter, nil, false, nil
	s.mu.Unlock()
	s.fetchPosts(channel, true)
}

// MorePosts asks for the next page of a forum's posts.
func (s *Store) MorePosts(channel int) {
	s.mu.Lock()
	l := s.forum.lists[channel]
	ok := l != nil && l.more && !l.loading
	s.mu.Unlock()
	if ok {
		s.fetchPosts(channel, false)
	}
}

func (s *Store) fetchPosts(channel int, reset bool) {
	s.mu.Lock()
	l := s.forum.lists[channel]
	if l == nil {
		s.mu.Unlock()
		return
	}
	l.ticket++
	mine, filter, offset := l.ticket, l.filter, len(l.posts)
	l.loading = true
	s.mu.Unlock()
	s.changed()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		page, err := s.client.Posts(ctx, channel, hclient.PostsQuery{Text: filter.Text, Sort: filter.Sort, Offset: offset, Mentions: filter.Mentions})
		s.mu.Lock()
		if l = s.forum.lists[channel]; l != nil && l.ticket == mine {
			l.loading, l.err = false, err
			if err == nil {
				posts := slices.Clone(l.posts)
				for _, p := range page.Posts {
					if !slices.ContainsFunc(posts, func(q Post) bool { return q.Msg.ID == p.Message.ID }) {
						posts = append(posts, Post{Msg: p.Message, Replies: p.ReplyCount, Last: p.LastActivityAt, Mentions: p.MentionCount})
					}
				}
				l.posts, l.more = posts, page.More
				arrange(l.posts, filter.Sort)
			}
		}
		s.mu.Unlock()
		s.changed()
	}()
}

// arrange puts the pinned posts first, the one pinned last on top, and the rest as the sort says.
func arrange(posts []Post, sort string) {
	slices.SortStableFunc(posts, func(a, b Post) int {
		if d := b.Msg.PostPinnedAt - a.Msg.PostPinnedAt; d != 0 {
			return int(max(-1, min(1, d)))
		}
		switch sort {
		case "activity":
			if d := b.Last - a.Last; d != 0 {
				return int(max(-1, min(1, d)))
			}
		case "replies":
			if d := b.Replies - a.Replies; d != 0 {
				return d
			}
			if d := b.Last - a.Last; d != 0 {
				return int(max(-1, min(1, d)))
			}
		}
		return b.Msg.ID - a.Msg.ID
	})
}

// noteForum keeps the open listing up to date with a message that arrived or changed: a post makes a line, an answer counts under its post.
func (s *Store) noteForum(arrived bool, m hclient.ChatMessage) {
	s.mu.Lock()
	l := s.forum.lists[m.ChannelID]
	if l == nil {
		s.mu.Unlock()
		return
	}
	mentioned := 0
	if m.UserID != s.client.User.ID && mentionsUser(m, s.client.User) {
		mentioned = 1
	}
	posts := slices.Clone(l.posts)
	switch {
	case m.Title != "":
		if i := slices.IndexFunc(posts, func(p Post) bool { return p.Msg.ID == m.ID }); i >= 0 {
			posts[i].Msg = m
		} else if arrived && l.filter.Text == "" && (!l.filter.Mentions || mentioned > 0) {
			posts = append(posts, Post{Msg: m, Last: m.CreatedAt, Mentions: mentioned})
		} else if arrived && l.filter.Text != "" && strings.Contains(strings.ToLower(m.Title+" "+m.Body), strings.ToLower(l.filter.Text)) && !l.filter.Mentions {
			posts = append(posts, Post{Msg: m, Last: m.CreatedAt})
		}
	case m.ThreadID != 0 && arrived:
		i := slices.IndexFunc(posts, func(p Post) bool { return p.Msg.ID == m.ThreadID })
		if i < 0 {
			if l.filter.Mentions && mentioned > 0 {
				s.mu.Unlock()
				s.fetchPosts(m.ChannelID, true)
				return
			}
			s.mu.Unlock()
			return
		}
		posts[i].Replies++
		posts[i].Mentions += mentioned
		posts[i].Last = max(posts[i].Last, m.CreatedAt)
	default:
		s.mu.Unlock()
		return
	}
	arrange(posts, l.filter.Sort)
	l.posts = posts
	s.mu.Unlock()
}

func (s *Store) forumReactions(id int, reactions []hclient.Reaction) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, l := range s.forum.lists {
		if i := slices.IndexFunc(l.posts, func(p Post) bool { return p.Msg.ID == id }); i >= 0 {
			l.posts = slices.Clone(l.posts)
			l.posts[i].Msg.Reactions = reactions
		}
	}
}

// MarkForumRead says all of a forum has been read.
func (s *Store) MarkForumRead(channel int) {
	s.mu.Lock()
	if s.read[channel] == math.MaxInt {
		s.mu.Unlock()
		return
	}
	s.read[channel] = math.MaxInt
	s.mu.Unlock()
	s.markAll(channel)
}

func (s *Store) markAll(channel int) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = s.client.MarkAllRead(ctx, channel)
	}()
}

// keepForumRead tells the server about what arrived in a forum that is open, so it does not count it as new.
func (s *Store) keepForumRead(channel int) {
	s.mu.Lock()
	open := s.read[channel] == math.MaxInt
	s.mu.Unlock()
	if open {
		s.markAll(channel)
	}
}

// ForgetForumRead lets a forum that was left count what comes next as new.
func (s *Store) ForgetForumRead(channel int) {
	s.mu.Lock()
	delete(s.read, channel)
	s.mu.Unlock()
}

func (s *Store) PinPost(ctx context.Context, id int, pinned bool) error {
	return s.client.PostPin(ctx, id, pinned)
}

// Creating is a post being written: the files go up, then the post, then the files after the first as answers under it.
type Creating struct {
	Sending
	Post atomic.Int64
}

// CreatePost starts a post in a forum. The first file goes with the post; each of the others is a message under it, from the same person.
func (s *Store) CreatePost(forum int, title, body string, paths []string) *Creating {
	op := &Creating{}
	var total int64
	for _, p := range paths {
		if info, err := os.Stat(p); err == nil {
			total += info.Size()
		}
	}
	op.Total.Store(total)
	go func() {
		defer func() { op.Done.Store(true); s.changed() }()
		if err := s.createPost(forum, title, body, paths, op); err != nil {
			op.Err.Store(err)
		}
	}()
	return op
}

func (s *Store) createPost(forum int, title, body string, paths []string, op *Creating) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	type sent struct{ hash, name string }
	var files []sent
	var base int64
	for _, path := range paths {
		hash, name, size, err := s.uploadPath(ctx, path, &op.Sending, base)
		if err != nil {
			return err
		}
		base += size
		files = append(files, sent{hash, name})
	}
	post := hclient.Post{Title: title, Body: body}
	if len(files) > 0 {
		post.AttachmentHash, post.AttachmentName = files[0].hash, files[0].name
	}
	msg, err := s.client.Send(ctx, forum, post)
	if err != nil {
		return err
	}
	op.Post.Store(int64(msg.ID))
	s.noteForum(true, msg)
	for _, f := range files[min(1, len(files)):] {
		answer, err := s.client.Send(ctx, forum, hclient.Post{ThreadID: msg.ID, AttachmentHash: f.hash, AttachmentName: f.name})
		if err != nil {
			return err
		}
		s.put(answer)
	}
	return nil
}

func (s *Store) uploadPath(ctx context.Context, path string, op *Sending, base int64) (hash, name string, size int64, err error) {
	file, err := os.Open(path)
	if err != nil {
		return "", "", 0, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", "", 0, err
	}
	name = filepath.Base(path)
	op.Name.Store(name)
	kind := strings.SplitN(mime.TypeByExtension(strings.ToLower(filepath.Ext(name))), ";", 2)[0]
	if kind == "" {
		kind = "application/octet-stream"
	}
	hash, err = s.client.Upload(ctx, file, info.Size(), kind, func(done int64) { op.Sent.Store(base + done); s.changed() })
	return hash, name, info.Size(), err
}
