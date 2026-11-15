package hclient

import "context"

// ForceMute silences somebody in a voice channel for everybody, or lets them speak again.
func (r *RT) ForceMute(ctx context.Context, channelID, mid int, muted bool) error {
	_, err := r.Request(ctx, "admin:force-mute", map[string]any{"channelId": channelID, "mid": mid, "muted": muted})
	return err
}

// MovePerson sends somebody into another voice channel, or out of voice when toChannel is 0.
func (r *RT) MovePerson(ctx context.Context, userID, toChannel int) error {
	var to any
	if toChannel != 0 {
		to = toChannel
	}
	_, err := r.Request(ctx, "admin:move", map[string]any{"userId": userID, "toChannelId": to})
	return err
}
