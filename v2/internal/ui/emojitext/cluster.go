// Package emojitext splits text into grapheme clusters, tells which of them are emoji, and draws those in colour from the system's emoji font.
package emojitext

import (
	"strings"
	"unicode/utf8"

	"github.com/rivo/uniseg"
)

const (
	zeroWidthJoiner = 0x200D
	variationText   = 0xFE0E
	variationEmoji  = 0xFE0F
	keycap          = 0x20E3
	skinToneLow     = 0x1F3FB
	skinToneHigh    = 0x1F3FF
	regionalLow     = 0x1F1E6
	regionalHigh    = 0x1F1FF
	plainLimit      = 0x300
	candidateLimit  = zeroWidthJoiner
)

// Segment is a run of text by rune index: either ordinary text or one emoji cluster.
type Segment struct {
	From, To int
	Emoji    bool
}

// MayContain is a cheap test that lets text without any emoji skip segmentation: every emoji cluster has a rune from U+200D up.
func MayContain(text string) bool {
	for i := 0; i < len(text); i++ {
		if text[i] >= utf8.RuneSelf {
			for _, r := range text[i:] {
				if r >= candidateLimit {
					return true
				}
			}
			return false
		}
	}
	return false
}

// Segments appends the text's segments, joining neighbouring non-emoji clusters into one.
func Segments(dst []Segment, text string) []Segment {
	at := 0
	for rest := text; rest != ""; {
		cluster, tail, _, _ := uniseg.FirstGraphemeClusterInString(rest, -1)
		n := utf8.RuneCountInString(cluster)
		emoji := IsCluster(cluster)
		if last := len(dst) - 1; !emoji && last >= 0 && !dst[last].Emoji {
			dst[last].To += n
		} else {
			dst = append(dst, Segment{From: at, To: at + n, Emoji: emoji})
		}
		at += n
		rest = tail
	}
	return dst
}

// IsCluster reports whether a grapheme cluster is drawn as an emoji: emoji presentation, a text-style pictograph made emoji by a variation selector, joiner or skin tone, a keycap or a flag.
func IsCluster(cluster string) bool {
	first, size := utf8.DecodeRuneInString(cluster)
	rest := cluster[size:]
	switch {
	case strings.ContainsRune(rest, variationText):
		return false
	case first >= regionalLow && first <= regionalHigh:
		return true
	case inSpans(presentation, first):
		return true
	case inSpans(pictographic, first):
		return strings.ContainsRune(rest, variationEmoji) || strings.ContainsRune(rest, zeroWidthJoiner) || hasSkinTone(rest)
	case first == '#' || first == '*' || (first >= '0' && first <= '9'):
		return strings.ContainsRune(rest, keycap)
	}
	return false
}

func hasSkinTone(s string) bool {
	for _, r := range s {
		if r >= skinToneLow && r <= skinToneHigh {
			return true
		}
	}
	return false
}

func plain(r rune) bool { return r < plainLimit && r != '\r' }

// ClusterEnds appends, for each grapheme cluster of text, the rune index just after it.
func ClusterEnds(dst []int, text []rune) []int {
	at := 0
	for at < len(text) && plain(text[at]) && (at+1 == len(text) || plain(text[at+1])) {
		at++
		dst = append(dst, at)
	}
	for rest := string(text[at:]); rest != ""; {
		cluster, tail, _, _ := uniseg.FirstGraphemeClusterInString(rest, -1)
		at += utf8.RuneCountInString(cluster)
		dst = append(dst, at)
		rest = tail
	}
	return dst
}

// NextCluster is the index after the grapheme cluster that starts at i.
func NextCluster(text []rune, i int) int {
	if i >= len(text) {
		return len(text)
	}
	if plain(text[i]) && (i+1 == len(text) || plain(text[i+1])) {
		return i + 1
	}
	cluster, _, _, _ := uniseg.FirstGraphemeClusterInString(string(text[i:]), -1)
	return i + utf8.RuneCountInString(cluster)
}

// PrevCluster is the start of the grapheme cluster that ends at i, or just before i.
func PrevCluster(text []rune, i int) int {
	if i <= 0 {
		return 0
	}
	if plain(text[i-1]) && (i == 1 || plain(text[i-2])) && (i == len(text) || plain(text[i])) {
		return i - 1
	}
	start := 0
	for rest := string(text[:i]); rest != ""; {
		cluster, tail, _, _ := uniseg.FirstGraphemeClusterInString(rest, -1)
		if tail == "" {
			break
		}
		start += utf8.RuneCountInString(cluster)
		rest = tail
	}
	return start
}

// ClusterLen is the length in bytes of the first grapheme cluster of s.
func ClusterLen(s string) int {
	cluster, _, _, _ := uniseg.FirstGraphemeClusterInString(s, -1)
	return len(cluster)
}
