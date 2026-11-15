package chat

import (
	"slices"
	"testing"
	"time"

	"harmony/v2/internal/hclient"
)

func TestCleanPoll(t *testing.T) {
	now := time.UnixMilli(1_000_000)
	cases := []struct {
		name string
		form PollForm
		want PollProblem
	}{
		{"fine", PollForm{Title: " Lunch? ", Options: []string{"a", " b ", ""}}, PollOK},
		{"no title", PollForm{Options: []string{"a", "b"}}, PollNeedsTitle},
		{"one option", PollForm{Title: "t", Options: []string{"a", "  "}}, PollNeedsOptions},
		{"end passed", PollForm{Title: "t", Options: []string{"a", "b"}, EndsAt: 999_999}, PollBadEnd},
		{"end unreadable", PollForm{Title: "t", Options: []string{"a", "b"}, EndsBad: true}, PollBadEnd},
		{"end too far", PollForm{Title: "t", Options: []string{"a", "b"}, EndsAt: now.Add(400 * 24 * time.Hour).UnixMilli()}, PollBadEnd},
	}
	for _, c := range cases {
		if _, got := CleanPoll(c.form, now); got != c.want {
			t.Errorf("%s: problem %v, want %v", c.name, got, c.want)
		}
	}
	draft, _ := CleanPoll(cases[0].form, now)
	if draft.Title != "Lunch?" || !slices.Equal(draft.Options, []string{"a", "b"}) {
		t.Errorf("draft %+v", draft)
	}
}

func TestPollAfterClick(t *testing.T) {
	one, many := &hclient.Poll{}, &hclient.Poll{Multiple: true}
	if got := PollAfterClick(one, []int{0}, 1); !slices.Equal(got, []int{1}) {
		t.Errorf("single, other option: %v", got)
	}
	if got := PollAfterClick(one, []int{1}, 1); len(got) != 0 || got == nil {
		t.Errorf("single, same option should leave an empty list: %v", got)
	}
	if got := PollAfterClick(many, []int{3, 1}, 2); !slices.Equal(got, []int{1, 2, 3}) {
		t.Errorf("multiple, add: %v", got)
	}
	if got := PollAfterClick(many, []int{1, 2}, 1); !slices.Equal(got, []int{2}) {
		t.Errorf("multiple, remove: %v", got)
	}
}

func TestPollTimeLeft(t *testing.T) {
	now := time.UnixMilli(0)
	at := func(d time.Duration) *hclient.Poll { return &hclient.Poll{EndsAt: now.Add(d).UnixMilli()} }
	for _, c := range []struct {
		left   time.Duration
		amount int
		unit   byte
	}{{30 * time.Second, 1, 'm'}, {59*time.Minute + time.Second, 1, 'h'}, {61 * time.Minute, 2, 'h'}, {25 * time.Hour, 2, 'd'}} {
		if a, u := PollTimeLeft(at(c.left), now); a != c.amount || u != c.unit {
			t.Errorf("%v left: %d%c, want %d%c", c.left, a, u, c.amount, c.unit)
		}
	}
	if a, _ := PollTimeLeft(at(-time.Second), now); a != 0 {
		t.Error("a closed poll has no time left")
	}
}
