package shell

import (
	"harmony/v2/internal/app"
	"harmony/v2/internal/hub"
	"harmony/v2/internal/ui/widget"
)

// cardCache is the card of the server the pointer rests on, rebuilt only when what it shows changed.
type cardCache struct {
	url   string
	sum   *hub.Summary
	state *app.State
	card  widget.ServerCard
}

func (sh *Shell) serverCard(url string) *widget.ServerCard {
	k := &sh.servers.card
	var sum *hub.Summary
	var state *app.State
	switch {
	case url == sh.open:
		state = sh.session.State()
	case sh.servers.held != nil && sh.servers.held.url == url:
		state = sh.servers.held.session.State()
	default:
		sum, _ = sh.servers.hub.Summary(url)
	}
	if k.url == url && k.sum == sum && k.state == state {
		return &k.card
	}
	saved, _ := sh.settings.Server(url)
	*k = cardCache{url: url, sum: sum, state: state, card: widget.ServerCard{Name: saved.Title()}}
	if look := sh.servers.looks[url]; look != nil {
		k.card.Logo, k.card.Banner = look.logo, look.banner
	}
	seen := map[int]bool{}
	add := func(id int, name string) {
		if !seen[id] {
			seen[id] = true
			k.card.Voice = append(k.card.Voice, widget.ServerCardPerson{Name: name})
		}
	}
	if sum != nil {
		for _, p := range sum.People {
			add(p.UserID, p.Nickname)
		}
	}
	if state != nil {
		for _, ch := range state.Channels {
			for _, m := range state.Rosters[ch.ID] {
				if ch.Kind == "voice" {
					add(m.UserID, m.Nickname)
				}
			}
		}
	}
	return &k.card
}
