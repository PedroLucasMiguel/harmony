package arrange

import (
	"reflect"
	"testing"
)

func list() []Node {
	return []Node{{ID: 1}, {ID: 2}, {Group: true, ID: 10, Kids: []int{3, 4}}, {Group: true, ID: 11}, {ID: 5}}
}

func TestMoveChannel(t *testing.T) {
	cases := []struct {
		name string
		id   int
		to   Drop
		want []Node
	}{
		{"into a group", 1, Drop{Kind: IntoGroup, ID: 11}, []Node{{ID: 2}, {Group: true, ID: 10, Kids: []int{3, 4}}, {Group: true, ID: 11, Kids: []int{1}}, {ID: 5}}},
		{"above one in a group", 5, Drop{Kind: BeforeChannel, ID: 4}, []Node{{ID: 1}, {ID: 2}, {Group: true, ID: 10, Kids: []int{3, 5, 4}}, {Group: true, ID: 11}}},
		{"out of a group below it", 3, Drop{Kind: AfterGroup, ID: 10}, []Node{{ID: 1}, {ID: 2}, {Group: true, ID: 10, Kids: []int{4}}, {ID: 3}, {Group: true, ID: 11}, {ID: 5}}},
		{"above a group", 2, Drop{Kind: BeforeGroup, ID: 11}, []Node{{ID: 1}, {Group: true, ID: 10, Kids: []int{3, 4}}, {ID: 2}, {Group: true, ID: 11}, {ID: 5}}},
		{"to the end", 4, Drop{Kind: End, ID: 0}, []Node{{ID: 1}, {ID: 2}, {Group: true, ID: 10, Kids: []int{3}}, {Group: true, ID: 11}, {ID: 5}, {ID: 4}}},
	}
	for _, c := range cases {
		if got := MoveChannel(list(), c.id, c.to); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
	if MoveChannel(list(), 1, Drop{Kind: BeforeChannel, ID: 1}) != nil || MoveChannel(list(), 1, Drop{Kind: IntoGroup, ID: 99}) != nil {
		t.Error("a Drop on itself or on nothing must be refused")
	}
}

func TestMoveGroup(t *testing.T) {
	got := MoveGroup(list(), 10, Drop{Kind: BeforeChannel, ID: 5})
	want := []Node{{ID: 1}, {ID: 2}, {Group: true, ID: 11}, {Group: true, ID: 10, Kids: []int{3, 4}}, {ID: 5}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if got := MoveGroup(list(), 11, Drop{Kind: BeforeChannel, ID: 3}); got[2].ID != 11 || got[3].ID != 10 {
		t.Errorf("above the channel of a group means above the group: %v", got)
	}
}

func TestNudge(t *testing.T) {
	if got := Nudge(list(), false, 4, -1); got[2].Kids[0] != 4 {
		t.Errorf("inside a group: %v", got)
	}
	if Nudge(list(), false, 3, -1) != nil || Nudge(list(), false, 1, -1) != nil {
		t.Error("the first one cannot go up")
	}
	if got := Nudge(list(), true, 10, 1); got[3].ID != 10 {
		t.Errorf("group: %v", got)
	}
}
