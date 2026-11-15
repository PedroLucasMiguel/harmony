package channels

import (
	"strings"

	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

// wrapText breaks text into lines no wider than width, the first starting indent in. With a limit only that many lines are
// kept, and the last ends in an ellipsis when words were left.
func wrapText(c *widget.Context, text string, st paint.TextStyle, width, indent float32, limit int) []string {
	var lines []string
	line, room := "", width-indent
	flush := func() {
		lines = append(lines, line)
		line, room = "", width
	}
	for _, word := range strings.Fields(text) {
		for {
			candidate := word
			if line != "" {
				candidate = line + " " + word
			}
			if c.Paint.TextWidth(candidate, st) <= room {
				line = candidate
				break
			}
			if line != "" {
				flush()
				continue
			}
			head, rest := splitToFit(c, word, st, room)
			if head == "" {
				head, rest = word[:runeLen(word)], word[runeLen(word):]
			}
			line = head
			flush()
			if rest == "" {
				break
			}
			word = rest
		}
	}
	if line != "" || len(lines) == 0 {
		lines = append(lines, line)
	}
	if limit > 0 && len(lines) > limit {
		lines = lines[:limit]
		room := width
		if limit == 1 {
			room -= indent
		}
		lines[limit-1] = ellipsize(c, lines[limit-1]+"…", st, room)
	}
	return lines
}

func runeLen(s string) int {
	for i := range s {
		if i > 0 {
			return i
		}
	}
	return len(s)
}

// splitToFit cuts the longest start of word that fits in width.
func splitToFit(c *widget.Context, word string, st paint.TextStyle, width float32) (head, rest string) {
	end := 0
	for i := range word {
		if i > 0 && c.Paint.TextWidth(word[:i], st) > width {
			break
		}
		end = i
	}
	if end == 0 && c.Paint.TextWidth(word, st) <= width {
		return word, ""
	}
	return word[:end], word[end:]
}

// ellipsize shortens a line ending in an ellipsis until it fits.
func ellipsize(c *widget.Context, line string, st paint.TextStyle, room float32) string {
	for c.Paint.TextWidth(line, st) > room {
		body := strings.TrimSuffix(line, "…")
		cut := []rune(body)
		if len(cut) == 0 {
			return "…"
		}
		line = string(cut[:len(cut)-1]) + "…"
	}
	return line
}
