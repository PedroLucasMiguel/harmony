package chat

import (
	"context"
	"mime"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"harmony/v2/internal/hclient"
)

// The limits the server holds a poll to.
const (
	PollTitleMax       = 200
	PollDescriptionMax = 1000
	PollOptionMax      = 100
	PollFooterMax      = 200
	PollMinOptions     = 2
	PollMaxOptions     = 12
	pollMaxDuration    = 366 * 24 * time.Hour
)

// PollProblem says what keeps a poll from being sent.
type PollProblem int

const (
	PollOK PollProblem = iota
	PollNeedsTitle
	PollNeedsOptions
	PollBadEnd
)

// PollForm is what was typed in. EndsAt is a Unix time in milliseconds, 0 for a poll that stays open; EndsBad is an end that could not be read.
type PollForm struct {
	Title, Description, Footer string
	Options                    []string
	Multiple, Anonymous        bool
	EndsAt                     int64
	EndsBad                    bool
}

func clip(s string, limit int) string {
	s = strings.TrimSpace(strings.NewReplacer("\r\n", "\n", "\r", "\n").Replace(s))
	if r := []rune(s); len(r) > limit {
		s = strings.TrimSpace(string(r[:limit]))
	}
	return s
}

// CleanPoll turns a form into what is sent, with the same rules as the server: trimmed, empty options dropped, limits applied.
func CleanPoll(f PollForm, now time.Time) (hclient.PollDraft, PollProblem) {
	draft := hclient.PollDraft{
		Title: clip(f.Title, PollTitleMax), Description: clip(f.Description, PollDescriptionMax), Footer: clip(f.Footer, PollFooterMax),
		Multiple: f.Multiple, Anonymous: f.Anonymous,
	}
	if draft.Title == "" {
		return draft, PollNeedsTitle
	}
	for _, o := range f.Options {
		if o = clip(o, PollOptionMax); o != "" {
			draft.Options = append(draft.Options, o)
		}
	}
	if len(draft.Options) < PollMinOptions || len(draft.Options) > PollMaxOptions {
		return draft, PollNeedsOptions
	}
	if f.EndsBad || (f.EndsAt != 0 && (f.EndsAt <= now.UnixMilli() || time.Duration(f.EndsAt-now.UnixMilli())*time.Millisecond > pollMaxDuration)) {
		return draft, PollBadEnd
	}
	draft.EndsAt = f.EndsAt
	return draft, PollOK
}

// PollClosed says whether a poll has reached its end.
func PollClosed(p *hclient.Poll, now time.Time) bool {
	return p.EndsAt != 0 && now.UnixMilli() >= p.EndsAt
}

// PollTimeLeft is how long a poll has left as its biggest whole unit: 'm', 'h' or 'd'. It is 0 when the poll is over or has no end.
func PollTimeLeft(p *hclient.Poll, now time.Time) (amount int, unit byte) {
	if p.EndsAt == 0 || PollClosed(p, now) {
		return 0, 0
	}
	minutes := max(1, int((time.Duration(p.EndsAt-now.UnixMilli())*time.Millisecond+time.Minute-1)/time.Minute))
	switch {
	case minutes < 60:
		return minutes, 'm'
	case minutes < 60*24:
		return (minutes + 59) / 60, 'h'
	}
	return (minutes + 60*24 - 1) / (60 * 24), 'd'
}

// PollAfterClick is what a click on an option leaves chosen: that option alone (or nothing if it was the one chosen) in a poll that takes one answer, and that option put in or taken out in one that takes several.
func PollAfterClick(p *hclient.Poll, mine []int, option int) []int {
	has := slices.Contains(mine, option)
	if !p.Multiple {
		if has {
			return []int{}
		}
		return []int{option}
	}
	next := slices.DeleteFunc(slices.Clone(mine), func(o int) bool { return o == option })
	if !has {
		next = append(next, option)
	}
	slices.Sort(next)
	return next
}

// Vote sends a vote; the counts the server answers with replace the poll's own.
func (s *Store) Vote(ctx context.Context, channel, message int, options []int) error {
	results, err := s.client.Vote(ctx, message, options)
	if err != nil {
		return err
	}
	s.setPollResults(channel, message, results)
	return nil
}

// setPollResults puts the counts where the poll is drawn from. What everybody is told does not say what this person chose (Mine is absent), so theirs is kept.
func (s *Store) setPollResults(channel, id int, results hclient.PollResults) {
	s.mu.Lock()
	f := s.holder(channel, id)
	if f == nil {
		s.mu.Unlock()
		return
	}
	i := slices.IndexFunc(f.entries, func(e *Entry) bool { return e.Msg.ID == id })
	if i < 0 || f.entries[i].Msg.Poll == nil {
		s.mu.Unlock()
		return
	}
	entries := slices.Clone(f.entries)
	old := entries[i]
	entry := &Entry{Msg: old.Msg, Layout: old.Layout}
	poll := *old.Msg.Poll
	if results.Mine == nil && old.Msg.Poll.Results != nil {
		results.Mine = old.Msg.Poll.Results.Mine
	}
	poll.Results = &results
	entry.Msg.Poll = &poll
	entries[i] = entry
	f.entries = entries
	s.mu.Unlock()
	s.changed()
}

// SendPoll posts a poll, uploading its picture first when it has one; progress is read from the returned value.
func (s *Store) SendPoll(channel int, draft hclient.PollDraft, picture string) *Sending {
	op := &Sending{}
	go func() {
		defer func() { op.Done.Store(true); s.changed() }()
		post := hclient.Post{Poll: &draft}
		if picture != "" {
			hash, name, err := s.uploadPicture(picture, op)
			if err != nil {
				op.Err.Store(err)
				return
			}
			post.AttachmentHash, post.AttachmentName = hash, name
		}
		if err := s.Send(context.Background(), channel, post); err != nil {
			op.Err.Store(err)
		}
	}()
	return op
}

func (s *Store) uploadPicture(path string, op *Sending) (hash, name string, err error) {
	file, err := os.Open(path)
	if err != nil {
		return "", "", err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", "", err
	}
	name = filepath.Base(path)
	op.Name.Store(name)
	op.Total.Store(info.Size())
	kind := strings.SplitN(mime.TypeByExtension(strings.ToLower(filepath.Ext(name))), ";", 2)[0]
	if kind == "" {
		kind = "application/octet-stream"
	}
	hash, err = s.client.Upload(context.Background(), file, info.Size(), kind, func(sent int64) { op.Sent.Store(sent); s.changed() })
	return hash, name, err
}
