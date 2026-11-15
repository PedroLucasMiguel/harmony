package channels

import (
	"image/color"
	"strconv"
	"strings"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/chat"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/markdown"
	"harmony/v2/internal/ui/emojitext"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	embedTop       = 6.4
	embedMaxW      = 432
	embedBar       = 3.913
	embedPadTop    = 9.6
	embedPadRight  = 12.8
	embedPadBottom = 12
	embedPadLeft   = 13.6
	embedGap       = 9.6
	embedTextGap   = 3.2
	embedRadius    = 6
	embedFill      = 0.06
	embedSiteSize  = 12
	embedTitleSize = 15.68
	embedDescSize  = 13.76
	embedLineScale = 1.35
	embedTitleRows = 2
	embedDescRows  = 4
	embedImageMax  = 260
	embedThumb     = 80
	embedThumbMin  = 300
	embedThumbAsp  = 1.4
	embedPlayDisc  = 51.2
	embedPlayIcon  = 22.4
	embedPlayAlpha = 0.55
)

var (
	siteStyle  = paint.TextStyle{Size: embedSiteSize, Weight: paint.Regular}
	titleStyle = paint.TextStyle{Size: embedTitleSize, Weight: paint.Semibold}
	descStyle  = paint.TextStyle{Size: embedDescSize, Weight: paint.Regular}
)

type embedShape uint8

const (
	embedPlain embedShape = iota
	embedLarge
	embedThumbnail
)

// embedLayout is a link's card laid out for a width.
type embedLayout struct {
	preview *hclient.LinkPreview
	width   float32
	hasPic  bool
	shape   embedShape
	site    string
	title   []string
	desc    []string
	textH   float32
	imageH  float32
	height  float32
	video   bool
	tint    color.RGBA
	top     float32
	picture geom.Rect
}

func (l *entryLayout) firstLink(body string) string {
	if !l.linkKnown {
		l.link, l.linkKnown = markdown.FirstLink(body), true
	}
	return l.link
}

// embedLayoutFor builds the card of a message's first link once its answer is in, and again when its picture arrives.
func (s *Screen) embedLayoutFor(c *widget.Context, l *entryLayout, msg *hclient.ChatMessage, w float32, load bool) *embedLayout {
	link := l.firstLink(msg.Body)
	if link == "" || msg.Poll != nil || !s.Settings.LinkPreviews || s.chat.dm && !s.Settings.DMLinkPreviews {
		return nil
	}
	if l.embedKey == "" {
		l.embedKey = s.Session.Client().Base + "#" + strconv.Itoa(msg.ID)
	}
	if l.embedGone || s.Settings.EmbedDismissed(l.embedKey) {
		l.embedGone = true
		return nil
	}
	var preview *hclient.LinkPreview
	var state chat.PreviewState
	if load {
		preview, state = s.Session.Chat().Preview(link)
	} else {
		preview, state = s.Session.Chat().PeekPreview(link)
	}
	if state != chat.PreviewReady {
		return nil
	}
	var pic *paint.Picture
	if preview.ImageHash != "" {
		if load {
			pic = c.Paint.PictureFrom(preview.ImageHash, s.Session.Chat())
		} else {
			pic = c.Paint.PeekPicture(preview.ImageHash)
		}
	}
	pw, ph, ready := 0, 0, false
	if pic != nil {
		pw, ph, ready = pic.Size()
	}
	if l.embed != nil && l.embed.preview == preview && l.embed.width == w && l.embed.hasPic == ready {
		return l.embed
	}
	l.embed = s.buildEmbed(c, preview, w, pw, ph, ready)
	return l.embed
}

func (s *Screen) buildEmbed(c *widget.Context, p *hclient.LinkPreview, w float32, pw, ph int, ready bool) *embedLayout {
	e := &embedLayout{preview: p, width: min(embedMaxW, w), hasPic: ready, site: p.Site, tint: c.Theme.Accent, top: embedTop}
	if p.Kind == "image" {
		return pictureEmbed(e, p, w, pw, ph, ready)
	}
	if rgb, ok := parseHex(p.Color); ok {
		e.tint = rgb
	}
	e.video = youtubeID(p.URL) || strings.Contains(p.Kind, "video")
	inner := e.width - embedBar - embedPadLeft - embedPadRight
	switch {
	case p.Kind == "image" || !ready && !e.video:
		e.shape = embedPlain
	case e.video:
		e.shape = embedLarge
	case pw < embedThumbMin || float32(pw)/float32(max(ph, 1)) < embedThumbAsp:
		e.shape = embedThumbnail
	default:
		e.shape = embedLarge
	}
	textW := inner
	if e.shape == embedThumbnail {
		textW -= embedThumb + embedGap
	}
	if e.site != "" {
		e.textH += embedSiteSize * embedLineScale
	}
	title := p.Title
	if title == "" {
		title = p.URL
	}
	e.title = clampLines(c, title, titleStyle, textW, embedTitleRows)
	e.desc = clampLines(c, p.Description, descStyle, textW, embedDescRows)
	parts := 0
	if e.site != "" {
		parts++
	}
	e.textH += float32(len(e.title)) * embedTitleSize * embedLineScale
	parts++
	if len(e.desc) > 0 {
		e.textH += float32(len(e.desc)) * embedDescSize * embedLineScale
		parts++
	}
	e.textH += float32(parts-1) * embedTextGap
	switch e.shape {
	case embedLarge:
		if e.video {
			e.imageH = inner * 9 / 16
		} else {
			e.imageH = min(embedImageMax, inner*float32(ph)/float32(max(pw, 1)))
		}
		e.height = embedPadTop + e.textH + embedGap + e.imageH + embedPadBottom
	case embedThumbnail:
		e.height = embedPadTop + max(e.textH, embedThumb) + embedPadBottom
	default:
		e.height = embedPadTop + e.textH + embedPadBottom
	}
	return e
}

func parseHex(s string) (color.RGBA, bool) {
	s = strings.TrimPrefix(s, "#")
	if len(s) == 3 {
		s = string([]byte{s[0], s[0], s[1], s[1], s[2], s[2]})
	}
	if len(s) != 6 {
		return color.RGBA{}, false
	}
	v, err := strconv.ParseUint(s, 16, 32)
	if err != nil {
		return color.RGBA{}, false
	}
	return color.RGBA{R: uint8(v >> 16), G: uint8(v >> 8), B: uint8(v), A: 255}, true
}

func youtubeID(url string) bool {
	for _, host := range []string{"youtube.com/", "youtu.be/", "youtube-nocookie.com/"} {
		if strings.Contains(url, host) && (strings.Contains(url, "watch?v=") || strings.Contains(url, "youtu.be/") || strings.Contains(url, "/shorts/") || strings.Contains(url, "/live/")) {
			return true
		}
	}
	return false
}

// clampLines wraps text to a width in at most max lines, ending the last with an ellipsis if more was left.
func clampLines(c *widget.Context, text string, style paint.TextStyle, width float32, max int) []string {
	if strings.TrimSpace(text) == "" {
		return nil
	}
	var lines []string
	for _, paragraph := range strings.Split(text, "\n") {
		current := ""
		for _, word := range strings.Fields(paragraph) {
			next := word
			if current != "" {
				next = current + " " + word
			}
			if c.Paint.TextWidth(next, style) <= width {
				current = next
				continue
			}
			if current != "" {
				lines = append(lines, current)
			}
			current = word
			for c.Paint.TextWidth(current, style) > width && emojitext.ClusterLen(current) < len(current) {
				cut := []rune(current)
				ends := emojitext.ClusterEnds(nil, cut)
				k := len(ends) - 2
				for k > 0 && c.Paint.TextWidth(string(cut[:ends[k]]), style) > width {
					k--
				}
				lines = append(lines, string(cut[:ends[k]]))
				current = string(cut[ends[k]:])
			}
		}
		lines = append(lines, current)
	}
	if len(lines) > max {
		last := []rune(lines[max-1])
		lines = lines[:max]
		for len(last) > 1 && c.Paint.TextWidth(string(last)+"…", style) > width {
			last = last[:emojitext.PrevCluster(last, len(last))]
		}
		lines[max-1] = string(last) + "…"
	}
	return lines
}

func (s *Screen) embedHeight(c *widget.Context, l *entryLayout, msg *hclient.ChatMessage, w float32, load bool) float32 {
	if e := s.embedLayoutFor(c, l, msg, w, load); e != nil && e.height > 0 {
		return e.top + e.height
	}
	return 0
}

func (s *Screen) drawEmbed(c *widget.Context, l *entryLayout, msg *hclient.ChatMessage, x, y, w float32) {
	e := s.embedLayoutFor(c, l, msg, w, true)
	if e == nil || e.height == 0 {
		return
	}
	if e.preview.Kind == "image" {
		s.drawPictureEmbed(c, e, x, y)
		return
	}
	card := geom.Rect{X: x, Y: y + embedTop, W: e.width, H: e.height}
	if s.embedClose(c, l, card) {
		return
	}
	s.drawEmbedCard(c, e, card)
	s.drawEmbedClose(c, card)
}

func (s *Screen) drawEmbedCard(c *widget.Context, e *embedLayout, card geom.Rect) {
	c.Paint.Fill(card, embedRadius, e.tint)
	inside := geom.Rect{X: card.X + embedBar, Y: card.Y, W: card.W - embedBar, H: card.H}
	c.Paint.Fill(inside, embedRadius, theme.Mix(c.Theme.Bg, c.Theme.Tint, embedFill))
	tx := card.X + embedBar + embedPadLeft
	top := card.Y + embedPadTop
	inner := card.W - embedBar - embedPadLeft - embedPadRight
	textW := inner
	if e.shape == embedThumbnail {
		textW -= embedThumb + embedGap
	}
	clip := geom.Rect{X: tx, Y: card.Y, W: textW, H: card.H}
	if e.site != "" {
		c.Paint.TextIn(clip, e.site, tx, top, embedSiteSize*embedLineScale, siteStyle, c.Theme.Muted)
		top += embedSiteSize*embedLineScale + embedTextGap
	}
	titleTop := top
	titleLine := float32(embedTitleSize * embedLineScale)
	for _, line := range e.title {
		c.Paint.Text(line, tx, top, titleLine, titleStyle, c.Theme.Accent)
		top += titleLine
	}
	if hit := (geom.Rect{X: tx, Y: titleTop, W: textW, H: top - titleTop}); c.Hovered(hit) {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(hit) {
			c.Claim()
			rl.OpenURL(e.preview.URL)
		}
	}
	top += embedTextGap
	descLine := float32(embedDescSize * embedLineScale)
	for _, line := range e.desc {
		c.Paint.Text(line, tx, top, descLine, descStyle, c.Theme.Text)
		top += descLine
	}
	if e.preview.ImageHash == "" || !e.hasPic {
		return
	}
	pic := c.Paint.PictureFrom(e.preview.ImageHash, s.Session.Chat())
	var frame geom.Rect
	switch e.shape {
	case embedLarge:
		frame = geom.Rect{X: tx, Y: card.Bottom() - embedPadBottom - e.imageH, W: inner, H: e.imageH}
	case embedThumbnail:
		frame = geom.Rect{X: tx + textW + embedGap, Y: card.Y + embedPadTop, W: embedThumb, H: embedThumb}
	default:
		return
	}
	c.Paint.DrawPicture(pic, frame, embedRadius, true, theme.Mix(c.Theme.Bg, c.Theme.Tint, embedFill))
	if e.video {
		centre := [2]float32{frame.X + frame.W/2, frame.Y + frame.H/2}
		c.Paint.Circle(centre[0], centre[1], embedPlayDisc/2, theme.WithAlpha(color.RGBA{A: 255}, embedPlayAlpha))
		c.Paint.Icon("play", geom.Rect{X: centre[0] - embedPlayIcon/2, Y: centre[1] - embedPlayIcon/2, W: embedPlayIcon, H: embedPlayIcon}, color.RGBA{255, 255, 255, 255})
	}
	if c.Hovered(frame) {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(frame) {
			c.Claim()
			rl.OpenURL(e.preview.URL)
		}
	}
}
