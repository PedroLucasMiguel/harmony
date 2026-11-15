package app

import (
	"harmony/v2/internal/faces"
	"harmony/v2/internal/people"
)

// People is who is on the server, with their pictures and how their names look.
func (s *Session) People() *people.Directory { return s.people }

// Faces are the pictures people put on their profile.
func (s *Session) Faces() *faces.Store { return s.faces }
