package store

import "slices"

const maxDismissedEmbeds = 500

// EmbedDismissed tells whether the person closed the link card under a message.
func (s *Settings) EmbedDismissed(key string) bool { return slices.Contains(s.DismissedEmbeds, key) }

// DismissEmbed keeps a link card closed, remembering the last few hundred.
func (s *Settings) DismissEmbed(key string) {
	if s.EmbedDismissed(key) {
		return
	}
	s.DismissedEmbeds = append(s.DismissedEmbeds, key)
	if n := len(s.DismissedEmbeds); n > maxDismissedEmbeds {
		s.DismissedEmbeds = slices.Clone(s.DismissedEmbeds[n-maxDismissedEmbeds:])
	}
	s.Save()
}
