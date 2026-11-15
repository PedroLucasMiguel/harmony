package app

import (
	"bytes"
	"context"

	"harmony/v2/internal/hclient"
)

// adoptMine puts the account's own profile, as the server answers a change to it, in the roster and in Me.
func (s *Session) adoptMine(u hclient.User) {
	s.mu.Lock()
	if s.dimHeld {
		u.BannerDim = s.dim
	}
	s.members = append([]hclient.Account(nil), s.members...)
	for i := range s.members {
		if s.members[i].ID == u.ID {
			s.members[i].Look, s.members[i].DisplayName = u.Look, u.DisplayName
		}
	}
	s.me.Look, s.me.DisplayName = u.Look, u.DisplayName
	s.rev++
	s.mu.Unlock()
	s.changed()
}

func (s *Session) change(u hclient.User, err error) error {
	if err == nil {
		s.adoptMine(u)
	}
	return err
}

// UploadFile stores a file on the server and returns the hash it is kept under.
func (s *Session) UploadFile(ctx context.Context, data []byte, contentType string) (string, error) {
	return s.client.Upload(ctx, bytes.NewReader(data), int64(len(data)), contentType, nil)
}

// SetAvatar points the profile picture at an uploaded image; an empty hash takes it away.
func (s *Session) SetAvatar(ctx context.Context, hash string) error {
	return s.change(s.client.SetAvatar(ctx, hash))
}

func (s *Session) SetBanner(ctx context.Context, hash string) error {
	return s.change(s.client.SetBanner(ctx, hash))
}

func (s *Session) SetJoinSound(ctx context.Context, hash string) error {
	return s.change(s.client.SetJoinSound(ctx, hash))
}

// SetBannerDim sets how dim the banner is drawn, 0 to 100; nil goes back to the default.
func (s *Session) SetBannerDim(ctx context.Context, dim *int) error {
	if dim == nil {
		return s.change(s.client.ClearBannerDim(ctx))
	}
	return s.change(s.client.SetBannerDim(ctx, *dim))
}

// ShowBannerDim makes the interface draw the banner at that dimming now, before the server has been told, and keeps it so
// whatever the server says of the account meanwhile, until ReleaseBannerDim.
func (s *Session) ShowBannerDim(dim *int) {
	s.mu.Lock()
	s.dimHeld, s.dim = true, dim
	s.members = append([]hclient.Account(nil), s.members...)
	for i := range s.members {
		if s.members[i].ID == s.me.ID {
			s.members[i].BannerDim = dim
		}
	}
	s.me.BannerDim = dim
	s.rev++
	s.mu.Unlock()
	s.changed()
}

func (s *Session) SetNameColor(ctx context.Context, style *hclient.NameStyle) error {
	return s.change(s.client.SetNameColor(ctx, style))
}

func (s *Session) SetNameFont(ctx context.Context, font string) error {
	return s.change(s.client.SetNameFont(ctx, font))
}

// ReleaseBannerDim lets the server's word on the banner's dimming count again.
func (s *Session) ReleaseBannerDim() {
	s.mu.Lock()
	s.dimHeld = false
	s.mu.Unlock()
}

// holdDim is a's account as the interface should draw it while the dimming is being moved by hand.
func (s *Session) holdDim(a hclient.Account) hclient.Account {
	if s.dimHeld && a.ID == s.me.ID {
		a.BannerDim = s.dim
	}
	return a
}
