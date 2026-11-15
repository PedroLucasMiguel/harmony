package chat

import (
	"testing"

	"harmony/v2/internal/hclient"
)

func TestArrangeKeepsPinnedOnTop(t *testing.T) {
	post := func(id int, pinned int64, replies int, last int64) Post {
		return Post{Msg: hclient.ChatMessage{ID: id, PostPinnedAt: pinned}, Replies: replies, Last: last}
	}
	posts := []Post{post(1, 0, 5, 10), post(2, 0, 1, 30), post(3, 100, 0, 1), post(4, 200, 0, 1), post(5, 0, 5, 20)}
	for sort, want := range map[string][]int{
		"new":      {4, 3, 5, 2, 1},
		"activity": {4, 3, 2, 5, 1},
		"replies":  {4, 3, 5, 1, 2},
	} {
		got := slicesClone(posts)
		arrange(got, sort)
		for i, p := range got {
			if p.Msg.ID != want[i] {
				t.Fatalf("%s: position %d is post %d, want %d", sort, i, p.Msg.ID, want[i])
			}
		}
	}
}

func slicesClone(p []Post) []Post { return append([]Post(nil), p...) }
