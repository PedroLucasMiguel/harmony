package widget

import (
	"image/color"
	"strconv"
	"strings"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/markdown"
	"harmony/v2/internal/ui/emojitext"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	bodySize        = 14
	bodyLine        = 21
	codeScale       = 0.9
	codeAlpha       = 0.1
	codePadX        = 3.78
	fenceScale      = 0.86
	fenceLineScale  = 1.5
	fenceMargin     = 4.8
	fencePadX       = 9.6
	fencePadY       = 8
	fenceRadius     = 6
	quoteMargin     = 3.2
	quoteBar        = 3
	quoteIndent     = 12.6
	listMargin      = 3.2
	listIndent      = 20.8
	headMargin      = 2.4
	mentionAlpha    = 0.18
	mentionPadX     = 2.8
	strikeAlpha     = 0.7
	chipRadius      = 4
	chipPadX        = 2.8
	strikeThickness = 1
	underlineDrop   = 7.5
)

type ink uint8

const (
	inkText ink = iota
	inkMuted
	inkLink
	inkMention
	inkMentionMe
	inkTint
)

type frag struct {
	x, y   float32
	text   string
	style  paint.TextStyle
	ink    ink
	strike bool
	width  float32
	clip   float32
	lh     float32
	// breaks is how many line breaks the source has before this fragment, and marker tells that it is a list's bullet or number, which is not text.
	breaks uint8
	marker bool
	tint   color.RGBA
}

type boxKind uint8

const (
	boxCode boxKind = iota
	boxMention
	boxMentionMe
	boxFence
	boxQuote
	boxTint
)

type box struct {
	r    geom.Rect
	kind boxKind
	tint color.RGBA
}

type linkArea struct {
	r   geom.Rect
	url string
}

// Mentioned tells whether an @name in a message names somebody, and whether that is the reader.
type Mentioned func(name string) (known, me bool)

// Chip says how an @name or a #channel is drawn: whether it names anything, what is shown in place of what was written, and whom it is about.
type Chip struct {
	Known bool
	Me    bool
	// Text, when set, is shown in place of the written name; Colour tints the chip of a role.
	Text   string
	Colour color.RGBA
	// Group is "everyone" or "role:<id>" for a chip that notifies several people; Person and Channel say whom or what a single chip points to.
	Group   string
	Person  int
	Channel int
}

// Chips resolves an @name or #channel as written, in lower case and with its mark.
type Chips func(written string) Chip

// ChipClick is a chip that was pressed, and where it is on the window.
type ChipClick struct {
	Chip Chip
	Rect geom.Rect
}

type chipArea struct {
	r    geom.Rect
	chip Chip
}

// RichText is a message body laid out for one width. It is built once and drawn every frame until the width changes.
type RichText struct {
	Width   float32
	Height  float32
	frags   []frag
	boxes   []box
	links   []linkArea
	images  []inlineImage
	emoji   EmojiFunc
	endX    float32
	endY    float32
	pick    pickState
	areas   []chipArea
	click   ChipClick
	pressed bool
}

type flow struct {
	c       *Context
	out     *RichText
	chips   Chips
	x0, w   float32
	x, y    float32
	lh      float32
	started bool
	run     *frag
	big     float32
	breaks  uint8
	tint    color.RGBA
	area    *Chip
}

// NewRichText lays blocks out in a column width wide.
func NewRichText(c *Context, blocks []markdown.Block, width float32, mention Mentioned) *RichText {
	return NewRichTextWith(c, blocks, width, mention, nil)
}

// NewRichTextWith is NewRichText that also resolves :name: shortcodes through emoji.
func NewRichTextWith(c *Context, blocks []markdown.Block, width float32, mention Mentioned, emoji EmojiFunc) *RichText {
	var chips Chips
	if mention != nil {
		chips = func(written string) Chip {
			if written[0] != '@' {
				return Chip{}
			}
			known, me := mention(written[1:])
			return Chip{Known: known, Me: me}
		}
	}
	return NewRichTextChips(c, blocks, width, chips, emoji)
}

// NewRichTextChips is NewRichTextWith that also resolves #channels and says how each chip looks and what it points to.
func NewRichTextChips(c *Context, blocks []markdown.Block, width float32, mention Chips, emoji EmojiFunc) *RichText {
	out := &RichText{Width: width, emoji: emoji}
	y := float32(0)
	prevMargin := float32(0)
	for i, b := range blocks {
		top, bottom := blockMargins(blocks, i)
		if i > 0 {
			y += max(prevMargin, top)
		}
		y += out.block(c, b, y, width, mention)
		prevMargin = bottom
	}
	out.Height = y
	return out
}

func blockMargins(blocks []markdown.Block, i int) (top, bottom float32) {
	switch blocks[i].Kind {
	case markdown.Fence:
		return fenceMargin, fenceMargin
	case markdown.Quote:
		return quoteMargin, quoteMargin
	case markdown.Heading:
		return headMargin, headMargin
	case markdown.Item:
		if i == 0 || blocks[i-1].Kind != markdown.Item {
			top = listMargin
		}
		if i == len(blocks)-1 || blocks[i+1].Kind != markdown.Item {
			bottom = listMargin
		}
	}
	return top, bottom
}

func (r *RichText) block(c *Context, b markdown.Block, y, width float32, mention Chips) float32 {
	switch b.Kind {
	case markdown.Fence:
		return r.fence(c, b.Code, y, width)
	case markdown.Quote:
		f := r.flow(c, mention, quoteIndent, width-quoteIndent, y, bodyLine)
		h := f.lines(b.Lines, bodySize, markdown.Flags(0), inkMuted)
		r.boxes = append(r.boxes, box{r: geom.Rect{X: 0, Y: y, W: quoteBar, H: h}, kind: boxQuote})
		return h
	case markdown.Item:
		marker := "•"
		if b.Number > 0 {
			marker = strconv.Itoa(b.Number) + "."
		}
		style := paint.TextStyle{Size: bodySize, Weight: paint.Regular}
		mw := c.Paint.TextWidth(marker, style)
		r.frags = append(r.frags, frag{x: listIndent - mw - 4, y: y, text: marker, style: style, ink: inkText, width: mw, marker: true})
		f := r.flow(c, mention, listIndent, width-listIndent, y, bodyLine)
		return f.lines(b.Lines, bodySize, markdown.Flags(0), inkText)
	case markdown.Heading:
		size := float32(bodySize)
		switch b.Level {
		case 1:
			size = bodySize * 1.08
		case 2:
			size = bodySize * 1.04
		}
		f := r.flow(c, mention, 0, width, y, size*1.5)
		return f.lines(b.Lines, size, markdown.Bold, inkText)
	}
	size, lh := float32(bodySize), float32(bodyLine)
	if b.Big {
		size, lh = bodySize*bigScale, bodySize*bigScale*bigLine
		if r.hasPicture(b) {
			lh = max(lh, size*bigImage)
		}
	}
	f := r.flow(c, mention, 0, width, y, lh)
	if b.Big {
		f.big = lh
	}
	return f.lines(b.Lines, size, markdown.Flags(0), inkText)
}

func (r *RichText) flow(c *Context, mention Chips, x0, w, y, lh float32) *flow {
	return &flow{c: c, out: r, chips: mention, x0: x0, w: w, x: x0, y: y, lh: lh, breaks: 1}
}

func (r *RichText) fence(c *Context, code string, y, width float32) float32 {
	style := paint.TextStyle{Size: bodySize * fenceScale, Weight: paint.Regular, Mono: true}
	lh := style.Size * fenceLineScale
	lines := strings.Split(code, "\n")
	h := 2*(fencePadY+c.Hairline()) + float32(len(lines))*lh
	r.boxes = append(r.boxes, box{r: geom.Rect{X: 0, Y: y, W: width, H: h}, kind: boxFence})
	for i, line := range lines {
		r.frags = append(r.frags, frag{
			breaks: 1, x: fencePadX + c.Hairline(), y: y + c.Hairline() + fencePadY + float32(i)*lh, text: strings.ReplaceAll(line, "\t", "    "), style: style, ink: inkText,
			clip: width - 2*(fencePadX+c.Hairline()),
		})
	}
	return h
}

// lines lays out the text lines of a block and returns their height.
func (f *flow) lines(lines [][]markdown.Span, size float32, extra markdown.Flags, base ink) float32 {
	top := f.y
	for i, line := range lines {
		if i > 0 {
			f.newLine()
			f.breaks++
		}
		f.started = false
		for _, span := range line {
			f.span(span, size, extra, base)
		}
		f.flush()
	}
	f.out.endX, f.out.endY = f.x, f.y
	return f.y + f.lh - top
}

func (f *flow) newLine() {
	f.flush()
	f.x, f.y, f.started = f.x0, f.y+f.lh, false
}

func (f *flow) flush() {
	if f.run != nil {
		f.out.frags = append(f.out.frags, *f.run)
		f.run = nil
	}
}

func (f *flow) span(s markdown.Span, size float32, extra markdown.Flags, base ink) {
	flags := s.Flags | extra
	if flags&markdown.Emoji != 0 {
		if f.emojiSpan(&s, size) {
			return
		}
		flags &^= markdown.Emoji
	}
	style := paint.TextStyle{Size: size, Weight: paint.Regular}
	kind := base
	var chip boxKind
	hasChip := false
	var tint color.RGBA
	var area *Chip
	switch {
	case flags&markdown.Code != 0:
		style.Size, style.Mono = size*codeScale, true
		chip, hasChip = boxCode, true
	case flags&(markdown.Mention|markdown.Channel) != 0 && f.chips != nil:
		if found := f.chips(strings.ToLower(s.Text)); found.Known {
			style.Weight = paint.Semibold
			kind, chip, hasChip = inkMention, boxMention, true
			if found.Me {
				kind, chip = inkMentionMe, boxMentionMe
			}
			if found.Colour.A != 0 {
				kind, chip, tint = inkTint, boxTint, found.Colour
			}
			if found.Text != "" {
				s.Text = found.Text
			}
			area = &found
		}
	}
	if flags&markdown.Bold != 0 {
		style.Weight = paint.Bold
	}
	style.Italic = flags&markdown.Italic != 0 && !style.Mono
	if flags&markdown.Link != 0 {
		kind = inkLink
	}
	strike := flags&markdown.Strike != 0
	pad := float32(0)
	if hasChip {
		pad = chipPadX
		if chip == boxCode {
			pad = codePadX
		}
	}
	f.tint, f.area = tint, area
	f.x += pad
	for _, word := range words(s.Text) {
		f.word(word, style, kind, strike, chip, hasChip, s.URL, flags&markdown.Link != 0)
	}
	f.x += pad
	f.tint, f.area = color.RGBA{}, nil
}

// words splits text into its words and the single spaces between them (a run of spaces counts as one).
func words(text string) []string {
	var out []string
	for i := 0; i < len(text); {
		j := i
		space := text[i] == ' '
		for j < len(text) && (text[j] == ' ') == space {
			j++
		}
		if space {
			out = append(out, " ")
		} else {
			out = append(out, text[i:j])
		}
		i = j
	}
	return out
}

func (f *flow) word(word string, style paint.TextStyle, kind ink, strike bool, chip boxKind, hasChip bool, url string, link bool) {
	if word == " " {
		if f.started {
			f.advance(" ", style, kind, strike, chip, hasChip, url, link, hasChip)
		}
		return
	}
	for {
		width := f.c.Paint.TextWidth(word, style)
		if f.x+width <= f.x0+f.w || !f.started && width <= f.w {
			f.advance(word, style, kind, strike, chip, hasChip, url, link, true)
			return
		}
		if f.started {
			f.newLine()
			continue
		}
		head := fitting(f.c, word, style, f.w)
		f.advance(head, style, kind, strike, chip, hasChip, url, link, true)
		f.newLine()
		word = word[len(head):]
		if word == "" {
			return
		}
	}
}

// fitting is the longest start of a word that fits in w, at least one character.
func fitting(c *Context, word string, style paint.TextStyle, w float32) string {
	end := 0
	for end < len(word) {
		next := end + emojitext.ClusterLen(word[end:])
		if c.Paint.TextWidth(word[:next], style) > w {
			break
		}
		end = next
	}
	if end == 0 {
		end = emojitext.ClusterLen(word)
	}
	return word[:end]
}

func (f *flow) advance(text string, style paint.TextStyle, kind ink, strike bool, chip boxKind, hasChip bool, url string, link, visible bool) {
	width := f.c.Paint.TextWidth(text, style)
	f.started = true
	if visible {
		if hasChip {
			f.out.boxes = append(f.out.boxes, box{r: geom.Rect{X: f.x - chipPadX, Y: f.y + (f.lh-chipHeight(style))/2, W: width + 2*chipPadX, H: chipHeight(style)}, kind: chip, tint: f.tint})
		}
		if link {
			f.out.links = append(f.out.links, linkArea{r: geom.Rect{X: f.x, Y: f.y, W: width, H: f.lh}, url: url})
		}
	}
	if f.area != nil && visible {
		f.out.areas = append(f.out.areas, chipArea{r: geom.Rect{X: f.x - chipPadX, Y: f.y + (f.lh-chipHeight(style))/2, W: width + 2*chipPadX, H: chipHeight(style)}, chip: *f.area})
	}
	if f.run != nil && f.run.tint == f.tint && f.run.style == style && f.run.ink == kind && f.run.strike == strike && f.run.y == f.y && f.run.x+f.run.width == f.x {
		f.run.text += text
		f.run.width += width
	} else {
		f.flush()
		f.run = &frag{x: f.x, y: f.y, text: text, style: style, ink: kind, strike: strike, width: width, lh: f.big, breaks: f.breaks, tint: f.tint}
		f.breaks = 0
	}
	f.x += width
}

func chipHeight(style paint.TextStyle) float32 { return style.Size * 1.3 }

func (r *RichText) colour(c *Context, k ink, tint color.RGBA) color.RGBA {
	switch k {
	case inkTint:
		return tint
	case inkMuted:
		return c.Theme.Muted
	case inkLink, inkMention:
		return c.Theme.Accent
	case inkMentionMe:
		return c.Theme.Warn
	}
	return c.Theme.Text
}

// End is where the last line of text stops, relative to the top left.
func (r *RichText) End() (x, y float32) { return r.endX, r.endY }

// Draw paints the text with its top left at x, y, and opens a link that was clicked.
func (r *RichText) Draw(c *Context, x, y float32) {
	r.pick.ox, r.pick.oy = x, y
	for _, b := range r.boxes {
		rect := geom.Rect{X: x + b.r.X, Y: y + b.r.Y, W: b.r.W, H: b.r.H}
		switch b.kind {
		case boxCode:
			c.Paint.Fill(rect, chipRadius, theme.WithAlpha(c.Theme.Tint, codeAlpha))
		case boxMention:
			c.Paint.Fill(rect, chipRadius, theme.WithAlpha(c.Theme.Accent, mentionAlpha))
		case boxMentionMe:
			c.Paint.Fill(rect, chipRadius, theme.WithAlpha(c.Theme.Warn, 0.22))
		case boxTint:
			c.Paint.Fill(rect, chipRadius, theme.WithAlpha(b.tint, mentionAlpha))
		case boxFence:
			c.Paint.Fill(rect, fenceRadius, c.Theme.Surface2)
			c.Paint.Stroke(rect, fenceRadius, c.Hairline(), c.Theme.Border)
		case boxQuote:
			c.Paint.Fill(rect, 0, c.Theme.BorderStrong)
		}
	}
	r.drawSelection(c, x, y)
	for _, f := range r.frags {
		fx, fy := x+f.x, y+f.y
		lh := f.lh
		if lh == 0 {
			lh = f.style.Size * 1.5
		}
		ink := r.colour(c, f.ink, f.tint)
		if f.clip > 0 {
			c.Paint.TextIn(geom.Rect{X: fx, Y: fy, W: f.clip, H: lh}, f.text, fx, fy, lh, f.style, ink)
			continue
		}
		c.Paint.Text(f.text, fx, fy, lh, f.style, ink)
		switch {
		case f.strike:
			c.Paint.Fill(geom.Rect{X: fx, Y: fy + lh/2, W: f.width, H: strikeThickness}, 0, theme.WithAlpha(ink, strikeAlpha))
		case f.ink == inkLink:
			c.Paint.Fill(geom.Rect{X: fx, Y: fy + lh/2 + underlineDrop, W: f.width, H: c.Hairline()}, 0, ink)
		}
	}
	r.drawImages(c, x, y)
	r.pressed = false
	for _, a := range r.areas {
		area := geom.Rect{X: x + a.r.X, Y: y + a.r.Y, W: a.r.W, H: a.r.H}
		if !c.Hovered(area) || a.chip.Group == "" && a.chip.Channel == 0 && a.chip.Person == 0 {
			continue
		}
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(area) {
			c.Claim()
			r.click, r.pressed = ChipClick{Chip: a.chip, Rect: area}, true
		}
	}
	for _, l := range r.links {
		area := geom.Rect{X: x + l.r.X, Y: y + l.r.Y, W: l.r.W, H: l.r.H}
		if !c.Hovered(area) {
			continue
		}
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(area) {
			c.Claim()
			rl.OpenURL(l.url)
		}
	}
}

// ChipPressed is the chip that was pressed during the last Draw, if one was.
func (r *RichText) ChipPressed() (ChipClick, bool) { return r.click, r.pressed }
