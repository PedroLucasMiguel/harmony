package chat

import (
	"testing"

	"harmony/v2/internal/hclient"
)

func TestPinBookOrder(t *testing.T) {
	var b pinBook
	pin := func(id int, on bool) hclient.ChatMessage {
		return hclient.ChatMessage{ID: id, ChannelID: 1, Pinned: on}
	}
	b.note(1, pin(1, true))
	b.note(1, pin(2, true))
	b.note(1, pin(1, true))
	if got := b.lists[1]; len(got) != 2 || got[0].ID != 2 || got[1].ID != 1 {
		t.Fatalf("a new pin goes first and an edited one stays: %+v", got)
	}
	b.note(1, pin(2, false))
	b.note(1, pin(9, false))
	if got := b.lists[1]; len(got) != 1 || got[0].ID != 1 {
		t.Fatalf("unpinned goes: %+v", got)
	}
	b.drop(1, 1)
	if len(b.lists[1]) != 0 {
		t.Fatal("deleted goes")
	}
}
