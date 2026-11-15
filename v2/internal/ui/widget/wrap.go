package widget

import (
	"strings"

	"harmony/v2/internal/ui/paint"
)

const wrapCacheSize = 256

type wrapKey struct {
	text  string
	style paint.TextStyle
	width float32
}

// wrapped remembers where text breaks into lines for a width, since the same notes and hints are laid out every frame.
// Like the shaper's cache, it keeps two generations, so what is still in use survives a turn.
var wrapped struct {
	now, older map[wrapKey][]string
}

func wrap(c *Context, text string, style paint.TextStyle, maxWidth float32) []string {
	key := wrapKey{text, style, maxWidth}
	if lines, ok := wrapped.now[key]; ok {
		return lines
	}
	lines, ok := wrapped.older[key]
	if !ok {
		lines = breakLines(c, text, style, maxWidth)
	}
	if len(wrapped.now) >= wrapCacheSize || wrapped.now == nil {
		wrapped.older, wrapped.now = wrapped.now, make(map[wrapKey][]string, wrapCacheSize)
	}
	wrapped.now[key] = lines
	return lines
}

func breakLines(c *Context, text string, style paint.TextStyle, maxWidth float32) []string {
	var lines []string
	current := ""
	for _, word := range strings.Fields(text) {
		candidate := word
		if current != "" {
			candidate = current + " " + word
		}
		if current != "" && c.Paint.TextWidth(candidate, style) > maxWidth {
			lines = append(lines, current)
			current = word
		} else {
			current = candidate
		}
	}
	return append(lines, current)
}
