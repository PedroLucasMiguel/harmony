package channels

import (
	"harmony/v2/internal/store"
	"harmony/v2/internal/ui/widget"
)

// finder is what the chat header offers for finding a message: the search, the pinned messages and the starred ones,
// and the jump to a message that each of them leads to.
type finder struct {
	c     *widget.Context
	scope string
	user  int
	url   string
	jump  jumpState
	pins  pinsPanel
	stars starsPanel

	search      searchState
	pinsButton  widget.Button
	starsButton widget.Button
	wired       bool
	currentHit  int
	channel     int
}

// starred says whether the message is starred by the person signed in; the scope is rebuilt only when it changes.
func (f *finder) starred(s *Screen, id int) bool {
	return f.scope != "" && s.Settings.Starred(f.scope, id)
}

func (f *finder) setScope(url string, user int) {
	if f.url != url || f.user != user {
		f.url, f.user = url, user
		f.scope = store.StarScope(url, user)
	}
}
