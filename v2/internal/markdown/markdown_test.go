package markdown

import (
	"reflect"
	"testing"
)

func TestInline(t *testing.T) {
	got := inline("it **really** works at https://a.b/c, `x*y*` snake_case @bob")
	want := []Span{
		{Text: "it "}, {Text: "really", Flags: Bold}, {Text: " works at "},
		{Text: "https://a.b/c,", Flags: Link, URL: "https://a.b/c,"}, {Text: " "},
		{Text: "x*y*", Flags: Code}, {Text: " snake_case "}, {Text: "@bob", Flags: Mention},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v", got)
	}
}

func TestBlocks(t *testing.T) {
	blocks := Parse("# hi\n> quoted\n1. one\n2. two\n```go\ncode\n```\nplain\nmore")
	kinds := []BlockKind{Heading, Quote, Item, Item, Fence, Paragraph}
	if len(blocks) != len(kinds) {
		t.Fatalf("got %d blocks", len(blocks))
	}
	for i, k := range kinds {
		if blocks[i].Kind != k {
			t.Fatalf("block %d is %d, want %d", i, blocks[i].Kind, k)
		}
	}
	if blocks[4].Code != "code" || len(blocks[5].Lines) != 2 || blocks[3].Number != 2 {
		t.Fatalf("%#v", blocks)
	}
}

func TestFirstLink(t *testing.T) {
	if got := FirstLink("see ```x``` and `https://no.pe` then (https://yes.pe/a)."); got != "https://yes.pe/a" {
		t.Fatalf("got %q", got)
	}
}

func TestItalic(t *testing.T) {
	cases := []struct {
		in   string
		want []Span
	}{
		{"a *b* c", []Span{{Text: "a "}, {Text: "b", Flags: Italic}, {Text: " c"}}},
		{"a _b_ c", []Span{{Text: "a "}, {Text: "b", Flags: Italic}, {Text: " c"}}},
		{"snake_case_name", []Span{{Text: "snake_case_name"}}},
		{"_a_b_", []Span{{Text: "_a_b_"}}},
		{"**a*", []Span{{Text: "*"}, {Text: "a", Flags: Italic}}},
		{"**b** *i*", []Span{{Text: "b", Flags: Bold}, {Text: " "}, {Text: "i", Flags: Italic}}},
	}
	for _, c := range cases {
		if got := inline(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q: got %#v", c.in, got)
		}
	}
}

func TestChannelReference(t *testing.T) {
	spans := Parse("see #general. and a&#b, #Locked-room!")[0].Lines[0]
	var got []string
	for _, s := range spans {
		if s.Flags&Channel != 0 {
			got = append(got, s.Text)
		}
	}
	if len(got) != 2 || got[0] != "#general" || got[1] != "#Locked-room" {
		t.Fatalf("channel references: %v", got)
	}
}
