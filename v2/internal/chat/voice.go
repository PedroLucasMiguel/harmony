package chat

import (
	"bytes"
	"context"

	"harmony/v2/internal/hclient"
)

// SendFile uploads a file held in memory and posts it as a message of its own; progress is read from the returned value.
func (s *Store) SendFile(channel int, name, contentType string, data []byte, replyTo int) *Sending {
	op := &Sending{}
	op.Name.Store(name)
	op.Total.Store(int64(len(data)))
	go func() {
		defer func() { op.Done.Store(true); s.changed() }()
		ctx := context.Background()
		hash, err := s.client.Upload(ctx, bytes.NewReader(data), int64(len(data)), contentType, func(sent int64) { op.Sent.Store(sent); s.changed() })
		if err == nil {
			err = s.Send(ctx, channel, hclient.Post{AttachmentHash: hash, AttachmentName: name, ReplyTo: replyTo})
		}
		if err != nil {
			op.Err.Store(err)
		}
	}()
	return op
}
