package app

import (
	"context"
	"time"
)

const peerAdminTimeout = 8 * time.Second

// ForceMute silences somebody in a voice channel for everybody, or lets them speak again; the server checks the rank.
func (s *Session) ForceMute(channelID, mid int, muted bool) error {
	ctx, cancel := context.WithTimeout(s.ctx, peerAdminTimeout)
	defer cancel()
	return s.rt.ForceMute(ctx, channelID, mid, muted)
}

// MovePerson sends somebody into another voice channel, or out of voice when toChannel is 0.
func (s *Session) MovePerson(userID, toChannel int) error {
	ctx, cancel := context.WithTimeout(s.ctx, peerAdminTimeout)
	defer cancel()
	return s.rt.MovePerson(ctx, userID, toChannel)
}
