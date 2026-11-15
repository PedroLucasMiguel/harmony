package channels

import (
	"context"
	"errors"
	"time"

	"harmony/v2/internal/chat"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/screens/poll"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
)

const pollTop = 4

var pollErrors = map[string]bool{"poll_closed": true, "bad_vote": true, "slow_down": true, "poll_needs_title": true, "poll_needs_options": true}

// pollCard is the card of a poll message, made the first time the message is laid out and kept with it.
func (s *Screen) pollCard(c *widget.Context, l *entryLayout, e *chat.Entry) *poll.Card {
	if l.poll != nil {
		return l.poll
	}
	channel, id := e.Msg.ChannelID, e.Msg.ID
	card := &poll.Card{}
	card.OnVote = func(options []int) {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			err := s.chatFeed().Vote(ctx, channel, id, options)
			card.Busy.Store(false)
			redraw.Request()
			if err != nil {
				s.fail(pollError(c, err, c.T("poll.vote_failed")))
			}
		}()
	}
	if e.Msg.AttachmentHash != "" {
		card.OnCover = func() {
			if pic := c.Paint.PeekPicture(e.Msg.AttachmentHash); pic != nil {
				c.OpenModal(&lightbox{pic: pic, name: e.Msg.AttachmentName, hash: e.Msg.AttachmentHash, screen: s})
			}
		}
	}
	l.poll = card
	return card
}

func pollError(c *widget.Context, err error, fallback string) error {
	var api *hclient.APIError
	if errors.As(err, &api) && pollErrors[api.Code] {
		return errors.New(c.T("poll.err_" + api.Code))
	}
	if err == nil || err.Error() == "" {
		return errors.New(fallback)
	}
	return err
}

func (s *Screen) pollSource(c *widget.Context, m model, e *chat.Entry, load bool) poll.Source {
	src := poll.Source{Poll: e.Msg.Poll, Members: m.state.Members}
	if hash := e.Msg.AttachmentHash; hash != "" {
		src.Cover = c.Paint.PeekPicture(hash)
		if src.Cover == nil && load {
			src.Cover = c.Paint.PictureFrom(hash, s.chatFeed())
		}
	}
	return src
}

// pollHeight is what a poll message's card takes under its name, 0 for any other message.
func (s *Screen) pollHeight(c *widget.Context, m model, e *chat.Entry, l *entryLayout, w float32) float32 {
	if e.Msg.Poll == nil {
		return 0
	}
	return pollTop + s.pollCard(c, l, e).Height(c, s.pollSource(c, m, e, false), w)
}

func (s *Screen) drawPoll(c *widget.Context, m model, e *chat.Entry, l *entryLayout, x, y, w float32) float32 {
	if e.Msg.Poll == nil {
		return 0
	}
	card := s.pollCard(c, l, e)
	card.Draw(c, s.pollSource(c, m, e, true), x, y+pollTop, w)
	return pollTop + card.Height(c, s.pollSource(c, m, e, false), w)
}

// startPoll opens the dialog a poll is made in; what it makes is sent to the channel that was open.
func (s *Screen) startPoll(c *widget.Context) {
	st := &s.chat
	if st.editing != nil {
		return
	}
	if s.uploading() {
		s.say(c.T("app.wait_for_the_file_already"))
		return
	}
	channel := st.channel
	poll.Open(c, func(draft hclient.PollDraft, picture string) {
		st.sending = s.chatFeed().SendPoll(channel, draft, picture)
	})
}
