// Package markdown reads the small subset of markdown a chat message may use: code, bold, italic, strike, links, quotes, lists, headings and fenced blocks.
package markdown

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"harmony/v2/internal/emoji"
)

type Flags uint8

const (
	Bold Flags = 1 << iota
	Italic
	Strike
	Code
	Link
	Mention
	Emoji
	Channel
)

// Span is a run of text that is all drawn the same way.
type Span struct {
	Text  string
	Flags Flags
	URL   string
}

type BlockKind uint8

const (
	Paragraph BlockKind = iota
	Heading
	Quote
	Item
	Fence
)

// Block is one paragraph, heading, quote, list item or fenced block. Lines hold the spans of each line of text.
type Block struct {
	Kind   BlockKind
	Level  int
	Number int
	Lines  [][]Span
	Code   string
	// Big is set on every block of a message that is nothing but emoji, which is drawn larger.
	Big bool
}

// Parse splits a message body into blocks.
func Parse(body string) []Block {
	lines := strings.Split(body, "\n")
	var blocks []Block
	for i := 0; i < len(lines); {
		line := lines[i]
		switch {
		case isFence(line, true):
			end := i + 1
			for end < len(lines) && !isFence(lines[end], false) {
				end++
			}
			blocks = append(blocks, Block{Kind: Fence, Code: strings.Join(lines[i+1:end], "\n")})
			i = end + 1
		case headLevel(line) > 0:
			level := headLevel(line)
			blocks = append(blocks, Block{Kind: Heading, Level: level, Lines: [][]Span{inline(strings.TrimLeft(line[level:], " \t"))}})
			i++
		case isQuote(line):
			block := Block{Kind: Quote}
			for ; i < len(lines) && isQuote(lines[i]); i++ {
				block.Lines = append(block.Lines, inline(stripQuote(lines[i])))
			}
			blocks = append(blocks, block)
		case itemMark(line) > 0:
			numbered := isNumbered(line)
			for n := 1; i < len(lines) && itemMark(lines[i]) > 0; i, n = i+1, n+1 {
				rest, _ := itemText(lines[i])
				number := 0
				if numbered {
					number = n
				}
				blocks = append(blocks, Block{Kind: Item, Number: number, Lines: [][]Span{inline(rest)}})
			}
		default:
			block := Block{Kind: Paragraph}
			for ; i < len(lines) && !startsBlock(lines[i]); i++ {
				block.Lines = append(block.Lines, inline(lines[i]))
			}
			blocks = append(blocks, block)
		}
	}
	return blocks
}

func startsBlock(line string) bool {
	return isFence(line, true) || headLevel(line) > 0 || isQuote(line) || itemMark(line) > 0
}

func indent(line string) (rest string, ok bool) {
	trimmed := strings.TrimLeft(line, " ")
	return trimmed, len(line)-len(trimmed) <= 3
}

func isFence(line string, opening bool) bool {
	rest, ok := indent(line)
	if !ok || !strings.HasPrefix(rest, "```") {
		return false
	}
	tag := strings.TrimSpace(rest[3:])
	if !opening {
		return tag == ""
	}
	return strings.IndexFunc(tag, func(r rune) bool { return !isWord(r) }) < 0
}

func headLevel(line string) int {
	n := 0
	for n < len(line) && line[n] == '#' {
		n++
	}
	if n == 0 || n > 3 || len(line) <= n || (line[n] != ' ' && line[n] != '\t') || strings.TrimSpace(line[n:]) == "" {
		return 0
	}
	return n
}

func isQuote(line string) bool {
	rest, ok := indent(line)
	return ok && strings.HasPrefix(rest, ">")
}

func stripQuote(line string) string {
	rest, _ := indent(line)
	return strings.TrimPrefix(strings.TrimPrefix(rest, ">"), " ")
}

// itemMark is the length of a list marker at the start of a line, or 0.
func itemMark(line string) int {
	rest, ok := indent(line)
	if !ok || rest == "" {
		return 0
	}
	if (rest[0] == '-' || rest[0] == '*' || rest[0] == '+') && len(rest) > 1 && (rest[1] == ' ' || rest[1] == '\t') {
		return 2
	}
	n := 0
	for n < len(rest) && rest[n] >= '0' && rest[n] <= '9' {
		n++
	}
	if n > 0 && n+1 < len(rest) && (rest[n] == '.' || rest[n] == ')') && (rest[n+1] == ' ' || rest[n+1] == '\t') {
		return n + 2
	}
	return 0
}

// isNumbered is whether a list starts with a number: the whole list is then numbered, as the first line decides.
func isNumbered(line string) bool {
	rest, _ := indent(line)
	return rest != "" && rest[0] >= '0' && rest[0] <= '9'
}

func itemText(line string) (string, int) {
	rest, _ := indent(line)
	n := itemMark(line)
	number := 0
	if rest[0] >= '0' && rest[0] <= '9' {
		for _, r := range rest[:n-2] {
			number = number*10 + int(r-'0')
		}
	}
	return strings.TrimLeft(rest[n:], " \t"), number
}

func isWord(r rune) bool { return r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r) }

// inline reads one line's formatting.
func inline(text string) []Span {
	var spans []Span
	plain := 0
	flush := func(upTo int) {
		if upTo > plain {
			spans = append(spans, Span{Text: text[plain:upTo]})
		}
	}
	emit := func(at, end int, spanned []Span) {
		flush(at)
		spans = append(spans, spanned...)
		plain = end
	}
	for i := 0; i < len(text); {
		if found, end := matchAt(text, i); found != nil {
			emit(i, end, found)
			i = end
			continue
		}
		i++
	}
	flush(len(text))
	return spans
}

// matchAt reads a formatted run starting at i, and says where it ends.
func matchAt(text string, i int) ([]Span, int) {
	rest := text[i:]
	switch {
	case rest[0] == '`':
		if end := strings.IndexByte(rest[1:], '`'); end > 0 && !strings.Contains(rest[1:1+end], "\n") {
			return []Span{{Text: rest[1 : 1+end], Flags: Code}}, i + end + 2
		}
	case strings.HasPrefix(rest, "**"):
		if end := strings.Index(rest[2:], "**"); end > 0 {
			return wrap(inline(rest[2:2+end]), Bold), i + end + 4
		}
	case strings.HasPrefix(rest, "__") && !wordBefore(text, i):
		if end := closeUnder(rest[2:], "__"); end > 0 {
			return wrap(inline(rest[2:2+end]), Bold), i + end + 4
		}
	case strings.HasPrefix(rest, "~~"):
		if end := strings.Index(rest[2:], "~~"); end > 0 {
			return wrap(inline(rest[2:2+end]), Strike), i + end + 4
		}
	case rest[0] == '*':
		if end := strings.IndexByte(rest[1:], '*'); end > 0 {
			return wrap(inline(rest[1:1+end]), Italic), i + end + 2
		}
	case rest[0] == '_' && !wordBefore(text, i):
		if end := closeSingle(rest[1:]); end > 0 {
			return wrap(inline(rest[1:1+end]), Italic), i + end + 2
		}
	case rest[0] == '[':
		if label, url, end := markdownLink(rest); end > 0 {
			return []Span{{Text: label, Flags: Link, URL: url}}, i + end
		}
	case strings.HasPrefix(rest, "http://") || strings.HasPrefix(rest, "https://"):
		end := strings.IndexAny(rest, " \t<")
		if end < 0 {
			end = len(rest)
		}
		if end > len("https://") {
			return []Span{{Text: rest[:end], Flags: Link, URL: rest[:end]}}, i + end
		}
	case rest[0] == ':':
		if n := shortcodeLen(rest); n > 0 {
			return []Span{{Text: rest[:n], Flags: Emoji}}, i + n
		}
	case rest[0] == '@' && !wordBefore(text, i):
		n := 1
		for n < len(rest) && (isWord(rune(rest[n])) || rest[n] == '-') {
			n++
		}
		if n > 1 {
			return []Span{{Text: rest[:n], Flags: Mention}}, i + n
		}
	case rest[0] == '#' && !channelBefore(text, i):
		if n := channelNameLen(rest[1:]); n > 0 {
			return []Span{{Text: rest[:1+n], Flags: Channel}}, i + 1 + n
		}
	}
	return nil, 0
}

const channelEnd = " \t\r\n#@:.,;!?()[]{}<>\"'`*~|\\/"

func channelBefore(text string, i int) bool {
	return i > 0 && (asciiWord(text[i-1]) || text[i-1] == '#' || text[i-1] == '&')
}

// channelNameLen is the length of a #channel's name at the start of s: up to 32 characters, ended by a space or punctuation.
func channelNameLen(s string) int {
	n, chars := 0, 0
	for n < len(s) && chars < 32 {
		r, size := utf8.DecodeRuneInString(s[n:])
		if strings.ContainsRune(channelEnd, r) {
			break
		}
		n += size
		chars++
	}
	return n
}

// shortcodeLen is the length of a :name: at the start of s, or 0.
func shortcodeLen(s string) int {
	end := strings.IndexByte(s[1:], ':')
	if end < 0 || !emoji.ValidName(s[1:1+end]) {
		return 0
	}
	return end + 2
}

// EmojiOnly says whether a message is nothing but emoji (and spaces): at least one character that is a picture, or a :name: that resolves.
func EmojiOnly(body string, resolves func(name string) bool) bool {
	found := false
	for i := 0; i < len(body); {
		r, size := utf8.DecodeRuneInString(body[i:])
		switch {
		case unicode.IsSpace(r), emoji.Joiner(r):
		case emoji.Pictographic(r):
			found = true
		case r == ':':
			n := shortcodeLen(body[i:])
			if n == 0 {
				return false
			}
			found = found || resolves(strings.ToLower(body[i+1:i+n-1]))
			size = n
		default:
			return false
		}
		i += size
	}
	return found
}

// Enlarge marks the blocks of a message as drawn large.
func Enlarge(blocks []Block) {
	for i := range blocks {
		blocks[i].Big = true
	}
}

func wrap(spans []Span, flag Flags) []Span {
	for i := range spans {
		spans[i].Flags |= flag
	}
	return spans
}

func asciiWord(b byte) bool {
	return b == '_' || b >= '0' && b <= '9' || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z'
}

// wordBefore is whether the text just before i ends in a word character, the way the Electron client's pattern reads \w: letters of the alphabet only.
func wordBefore(text string, i int) bool {
	return i > 0 && asciiWord(text[i-1])
}

// closeSingle finds the underscore that closes a one-underscore run: the next one, with something between, and no word character after it.
func closeSingle(s string) int {
	end := strings.IndexByte(s, '_')
	if end <= 0 || strings.Contains(s[:end], "\n") || (end+1 < len(s) && asciiWord(s[end+1])) {
		return -1
	}
	return end
}

// closeUnder finds the closing underscore marker, which must not be followed by a word character.
func closeUnder(s, marker string) int {
	for from := 0; ; {
		at := strings.Index(s[from:], marker)
		if at < 0 {
			return -1
		}
		at += from
		after := s[at+len(marker):]
		if at > 0 && (after == "" || !asciiWord(after[0])) && !strings.Contains(s[:at], "\n") {
			return at
		}
		from = at + 1
	}
}

func markdownLink(s string) (label, url string, end int) {
	close := strings.Index(s, "](")
	if close < 2 {
		return "", "", 0
	}
	stop := strings.IndexByte(s[close+2:], ')')
	if stop < 0 {
		return "", "", 0
	}
	label, url = s[1:close], s[close+2:close+2+stop]
	if strings.ContainsAny(label, "]\n") || !(strings.HasPrefix(url, "http://") || strings.HasPrefix(url, "https://")) || strings.ContainsAny(url, " \t") {
		return "", "", 0
	}
	return label, url, close + 3 + stop
}

var (
	fenced   = regexp.MustCompile("(?s)```.*?```")
	inlined  = regexp.MustCompile("`[^`\\n]*`")
	anyLink  = regexp.MustCompile(`https?://[^\s<>]+`)
	sentence = ".,;:!?)]}'\"*_~"
)

// FirstLink is the address in a message that gets a card: the first one outside code, without the punctuation that ends a sentence.
func FirstLink(body string) string {
	text := inlined.ReplaceAllString(fenced.ReplaceAllString(body, " "), " ")
	url := strings.TrimRight(anyLink.FindString(text), sentence)
	if len(url) > len("https://x") {
		return url
	}
	return ""
}
