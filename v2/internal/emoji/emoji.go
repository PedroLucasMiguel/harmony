// Package emoji holds the standard emoji the picker offers, by section, and the names typed between colons for them.
// The data is the Electron client's list (emoji.tsv, one "character<TAB>name" per line, a "#id<TAB>label" line starting each section).
package emoji

import (
	_ "embed"
	"strings"
	"sync"
	"sync/atomic"
)

//go:embed emoji.tsv
var data string

// Item is one emoji and the name it is typed with.
type Item struct{ Char, Name string }

type Section struct {
	Label string
	Items []Item
}

var (
	once     sync.Once
	ready    atomic.Bool
	sections []Section
	byName   map[string]string
	all      []Item
)

// Warm builds the tables on another goroutine, so that the first picker or message that needs them does not wait.
func Warm() { go once.Do(build) }

// Ready says whether the tables are built.
func Ready() bool { return ready.Load() }

func build() {
	byName = make(map[string]string, 1600)
	all = make([]Item, 0, 1500)
	for line := range strings.SplitSeq(data, "\n") {
		left, right, ok := strings.Cut(line, "\t")
		if !ok {
			continue
		}
		if left[0] == '#' {
			sections = append(sections, Section{Label: right})
			continue
		}
		item := Item{Char: left, Name: right}
		last := &sections[len(sections)-1]
		last.Items = append(last.Items, item)
		all = append(all, item)
		byName[right] = left
	}
	for name, char := range aliases {
		byName[name] = char
	}
	ready.Store(true)
}

// Sections lists the emoji by section, in the order the picker shows them.
func Sections() []Section {
	once.Do(build)
	return sections
}

// Lookup resolves a typed :name: (without the colons) to its character.
func Lookup(name string) (string, bool) {
	once.Do(build)
	char, ok := byName[name]
	return char, ok
}

// NameOf is the name an emoji is shown with in the picker, or empty.
func NameOf(char string) string {
	once.Do(build)
	for _, item := range all {
		if item.Char == char {
			return item.Name
		}
	}
	return ""
}

// Search lists the emoji whose name contains the query, at most limit of them, the start of the list first.
func Search(query string, limit int, into []Item) []Item {
	once.Do(build)
	for _, item := range all {
		if len(into) >= limit {
			break
		}
		if strings.Contains(item.Name, query) {
			into = append(into, item)
		}
	}
	return into
}

// Query turns what was typed in the search box into what names are matched against: lower case, words joined with underscores.
func Query(typed string) string {
	var b strings.Builder
	pending := false
	for _, r := range strings.ToLower(strings.TrimSpace(typed)) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_' {
			if pending && b.Len() > 0 {
				b.WriteByte('_')
			}
			pending = false
			b.WriteRune(r)
		} else {
			pending = true
		}
	}
	return b.String()
}

// ValidName says whether a name between colons can be an emoji name: 2 to 32 letters, digits or underscores.
func ValidName(name string) bool {
	if len(name) < 2 || len(name) > 32 {
		return false
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	return true
}

// Pictographic is whether a character is drawn as a picture rather than a letter: what counts as an emoji in a message of nothing but emoji.
func Pictographic(r rune) bool {
	switch {
	case r >= 0x1F1E6 && r <= 0x1F1FF:
		return false
	case r >= 0x1F300 && r <= 0x1FAFF, r >= 0x1F000 && r <= 0x1F2FF:
		return true
	case r >= 0x2600 && r <= 0x27BF, r >= 0x2B00 && r <= 0x2BFF, r >= 0x2190 && r <= 0x21FF, r >= 0x2300 && r <= 0x23FF:
		return true
	}
	switch r {
	case 0xA9, 0xAE, 0x203C, 0x2049, 0x2122, 0x2139, 0x24C2, 0x25AA, 0x25AB, 0x25B6, 0x25C0, 0x3030, 0x303D, 0x3297, 0x3299:
		return true
	}
	return false
}

// Joiner reports the characters that glue emoji together: zero-width joiner, the emoji variation selector and the skin tones.
func Joiner(r rune) bool { return r == 0x200D || r == 0xFE0F || r >= 0x1F3FB && r <= 0x1F3FF }
