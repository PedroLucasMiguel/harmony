package poll

import (
	"strings"

	"harmony/v2/internal/ui/emojitext"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

// wrap breaks text into lines no wider than width: at spaces, and inside a word that is longer than a line, as the Electron card does.
// Line breaks in the text are kept.
func wrap(c *widget.Context, text string, style paint.TextStyle, width float32) []string {
	var lines []string
	for _, paragraph := range strings.Split(text, "\n") {
		lines = wrapParagraph(c, lines, paragraph, style, width)
	}
	return lines
}

func wrapParagraph(c *widget.Context, lines []string, paragraph string, style paint.TextStyle, width float32) []string {
	fits := func(s string) bool { return c.Paint.TextWidth(s, style) <= width }
	line := ""
	for _, word := range strings.Fields(paragraph) {
		candidate := word
		if line != "" {
			candidate = line + " " + word
		}
		if fits(candidate) {
			line = candidate
			continue
		}
		if line != "" {
			lines = append(lines, line)
			line = ""
		}
		for !fits(word) {
			cut := fitting(c, word, style, width)
			lines = append(lines, word[:cut])
			word = word[cut:]
		}
		line = word
	}
	return append(lines, line)
}

// fitting is how many bytes of a word fit on a line, at least one cluster.
func fitting(c *widget.Context, word string, style paint.TextStyle, width float32) int {
	runes := []rune(word)
	ends := emojitext.ClusterEnds(nil, runes)
	best := ends[0]
	for _, end := range ends {
		if c.Paint.TextWidth(string(runes[:end]), style) > width {
			break
		}
		best = end
	}
	return len(string(runes[:best]))
}
