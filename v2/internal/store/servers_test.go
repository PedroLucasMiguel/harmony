package store

import (
	"slices"
	"testing"
)

func urls(s *Settings) []string {
	var out []string
	for _, server := range s.Servers {
		out = append(out, server.URL)
	}
	return out
}

func TestMoveServer(t *testing.T) {
	s := &Settings{}
	for _, u := range []string{"a", "b", "c", "d"} {
		s.RememberServer(Server{URL: u})
	}
	s.MoveServer("a", "c", true)
	if got := urls(s); !slices.Equal(got, []string{"b", "c", "a", "d"}) {
		t.Fatalf("after: %v", got)
	}
	s.MoveServer("d", "b", false)
	if got := urls(s); !slices.Equal(got, []string{"d", "b", "c", "a"}) {
		t.Fatalf("before: %v", got)
	}
	s.RememberServer(Server{URL: "c", Name: "C"})
	if got := urls(s); !slices.Equal(got, []string{"d", "b", "c", "a"}) || s.LastServer() != "c" {
		t.Fatalf("remember moved it: %v %s", got, s.LastServer())
	}
}
