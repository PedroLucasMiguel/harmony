package widget

import (
	"strings"
	"sync"
)

const memoLimit = 512

// memo remembers what a pure function of a string gave, since the same few names and titles are asked about every frame.
type memo struct {
	fn   func(string) string
	mu   sync.Mutex
	seen map[string]string
}

func (m *memo) of(s string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if v, ok := m.seen[s]; ok {
		return v
	}
	if m.seen == nil || len(m.seen) >= memoLimit {
		m.seen = make(map[string]string, memoLimit)
	}
	v := m.fn(s)
	m.seen[s] = v
	return v
}

var (
	uppercase = memo{fn: strings.ToUpper}
	initialsM = memo{fn: func(name string) string {
		runes := []rune(strings.ToUpper(strings.TrimSpace(name)))
		return string(runes[:min(len(runes), 2)])
	}}
	initialM = memo{fn: func(name string) string {
		return strings.ToUpper(firstLetter(strings.TrimSpace(name)))
	}}
)

// Upper is s in capitals.
func Upper(s string) string { return uppercase.of(s) }
