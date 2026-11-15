package app

import (
	"harmony/v2/internal/dm"
)

// startDM brings up the private conversations in the background: the keys are fetched (and made for an account that has
// none) without making the sign-in wait for them.
func (s *Session) startDM() {
	opt := dm.Options{
		Client: s.client, Me: s.me.ID, KeyPath: dm.KeyPath(s.client.Base, s.me.ID), Changed: s.changed, OnIncoming: s.directMessage,
	}
	d, err := dm.New(opt)
	if err != nil {
		s.logf("%v: private conversations keep their keys in memory only", err)
		opt.KeyPath = ""
		d, _ = dm.New(opt)
	}
	s.dm = d
	go d.Start(s.ctx)
}
