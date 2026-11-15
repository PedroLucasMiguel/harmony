package channels

import (
	"slices"
	"testing"

	"harmony/v2/internal/app"
	"harmony/v2/internal/hclient"
)

func TestQueryFromChips(t *testing.T) {
	start, _ := dayStart("2026-10-30")
	q := &searchState{}
	for _, c := range []filter{
		{key: "from", id: 3}, {key: "from", id: 4}, {key: "has", word: "sound"}, {key: "pinned", word: "false"},
		{key: "during", word: "2026-10-30"}, {key: "after", word: "2026-10-01"},
	} {
		q.addChip(c)
	}
	req := q.query("deploy", 2)
	if !slices.Equal(req.From, []int{3, 4}) || !slices.Equal(req.Has, []string{"audio"}) || req.Pinned != -1 {
		t.Fatalf("filters wrong: %+v", req)
	}
	if req.Offset != 2*searchPage || req.Before != start+dayMillis {
		t.Fatalf("paging or dates wrong: %+v", req)
	}
	if req.After != start-1 {
		t.Fatalf("after must be the later of the bounds: %d", req.After)
	}
}

func TestAbsorbTokens(t *testing.T) {
	m := model{state: &app.State{Members: []hclient.Account{{ID: 7, Nickname: "ana", DisplayName: "Ana"}}}}
	q := &searchState{}
	q.field.SetValue("from:ana from:nobody hello ")
	if !q.absorbTokens(m) {
		t.Fatal("from:ana should become a chip")
	}
	if len(q.chips) != 1 || q.chips[0].id != 7 || q.field.Value != "from:nobody hello " {
		t.Fatalf("chips %+v, text %q", q.chips, q.field.Value)
	}
}

func TestHasWordsFoldsAccents(t *testing.T) {
	if !hasWords("cafe LATTE", "A Café, a latte") || hasWords("tea", "A Café") {
		t.Fatal("hasWords must ignore case and accents and need every word")
	}
}
