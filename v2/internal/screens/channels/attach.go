package channels

import (
	"fmt"
	"math"
	"path/filepath"
	"strings"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/chat"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	attachTop       = 4
	attachBarTop    = 2.4
	attachBarLine   = 18.72
	attachBarSize   = 12.48
	imageMaxW       = 420
	imageMaxH       = 300
	imageRadius     = 6
	inlineMediaMax  = 64 << 20
	cardMaxW        = 420
	cardPadX        = 12.8
	cardPadY        = 11.2
	cardIcon        = 38.4
	cardGap         = 11.2
	cardRadius      = 8
	cardNameSize    = 15.2
	cardNameLine    = 22.8
	cardSizeLine    = 18.72
	cardTextGap     = 1.6
	cardFillAlpha   = 0.05
	textCardMaxW    = 720
	textBodyPadX    = 12.8
	textBodyPadY    = 9.6
	textLineSize    = 12.8
	textLine        = 16.64
	textFoldedLines = 10
	textOpenLines   = 25
	textLeftTop     = 5.6
	textLeftSize    = 12.48
	textFootPadX    = 11.2
	textFootPadY    = 8
	textFootGap     = 11.2
	textToggle      = 32
	textNameSize    = 14.4
	textNameLine    = 21.6
	textSizeSize    = 12.16
	textSizeLine    = 18.24
	textShade       = 0.22
	attachButtonW   = 29.4
	attachButtonH   = 26.2
	attachIcon      = 17.6
)

var (
	barStyle   = paint.TextStyle{Size: attachBarSize, Weight: paint.Regular}
	monoStyle  = paint.TextStyle{Size: textLineSize, Weight: paint.Regular, Mono: true}
	leftStyle  = paint.TextStyle{Size: textLeftSize, Weight: paint.Regular}
	cardName   = paint.TextStyle{Size: cardNameSize, Weight: paint.Regular}
	textName   = paint.TextStyle{Size: textNameSize, Weight: paint.Regular}
	sizeStyle  = paint.TextStyle{Size: textSizeSize, Weight: paint.Regular}
	cardSizeSt = paint.TextStyle{Size: attachBarSize, Weight: paint.Regular}
)

type attachKind uint8

const (
	attachNone attachKind = iota
	attachImage
	attachText
	attachCard
	attachVoice
	attachAudio
)

type attachPlan struct {
	kind attachKind
	h    float32
	pic  *paint.Picture
	imgW float32
	imgH float32
	head chat.Head
	rows int
}

func (s *Screen) kindOf(e *chat.Entry) attachKind {
	msg := &e.Msg
	switch {
	case msg.AttachmentHash == "" || msg.Poll != nil:
		return attachNone
	case msg.AttachmentBytes > inlineMediaMax:
		return attachCard
	case msg.MediaType == "image":
		return attachImage
	case s.isVoiceNote(e):
		return attachVoice
	case msg.MediaType == "audio":
		return attachAudio
	case msg.MediaType == "file" && chat.PreviewsAsText(msg.AttachmentName, msg.AttachmentBytes):
		return attachText
	}
	return attachCard
}

// plan works out what an attachment looks like now; with load set it also starts fetching what it shows.
func (s *Screen) plan(c *widget.Context, e *chat.Entry, w float32, load bool) attachPlan {
	p := attachPlan{kind: s.kindOf(e)}
	msg := &e.Msg
	switch p.kind {
	case attachImage:
		if load {
			p.pic = c.Paint.PictureFrom(msg.AttachmentHash, s.chatFeed())
		} else {
			p.pic = c.Paint.PeekPicture(msg.AttachmentHash)
		}
		p.h = attachTop + attachBarTop + attachBarLine
		if p.pic != nil {
			if pw, ph, ok := p.pic.Size(); ok {
				scale := min(1, min(imageMaxW, w)/float32(pw), imageMaxH/float32(ph))
				p.imgW, p.imgH = float32(pw)*scale, float32(ph)*scale
				p.h += p.imgH
			}
		}
	case attachText:
		if load {
			p.head = s.chatFeed().Head(msg.AttachmentHash, msg.AttachmentBytes)
		} else if h, ok := s.chatFeed().PeekHead(msg.AttachmentHash); ok {
			p.head = h
		}
		p.h = attachTop + s.textCardHeight(&p, msg.AttachmentBytes, s.chat.unfolded[msg.ID])
	case attachVoice:
		p.h = attachTop + voiceRowH
	case attachAudio:
		p.h = attachTop + 54 + audioRowGap + attachBarLine
	case attachCard:
		p.h = attachTop + 2*(cardPadY+1) + max(cardIcon, cardNameLine+cardTextGap+cardSizeLine)
	}
	return p
}

func (s *Screen) attachmentHeight(c *widget.Context, e *chat.Entry, w float32) float32 {
	return s.plan(c, e, w, false).h
}

func (s *Screen) textCardHeight(p *attachPlan, size int64, unfolded bool) float32 {
	limit := textFoldedLines
	if unfolded {
		limit = textOpenLines
	}
	rows, left := 0, false
	if p.head.Ready && !p.head.Binary {
		rows = min(len(p.head.Lines), limit)
		left = len(p.head.Lines) > rows || p.head.LeftLines > 0 || p.head.LeftBytes > 0
	} else {
		rows = int(min(float64(textFoldedLines), math.Max(1, math.Ceil(float64(size)/60))))
	}
	p.rows = rows
	body := 2*textBodyPadY + float32(rows)*textLine
	if left {
		body += textLeftTop + attachBarLine
	}
	foot := float32(2*textFootPadY + textNameLine + cardTextGap + textSizeLine)
	return 2 + body + 1 + foot
}

func formatBytes(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.2f GB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.2f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.0f KB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d bytes", n)
}

func (s *Screen) drawAttachment(c *widget.Context, e *chat.Entry, l *entryLayout, x, y, w float32) float32 {
	p := s.plan(c, e, w, true)
	y += attachTop
	switch p.kind {
	case attachImage:
		s.drawImage(c, e, l, p, x, y)
	case attachText:
		s.drawTextCard(c, e, l, p, x, y, w)
	case attachVoice:
		s.drawVoiceNote(c, e, x, y, w)
	case attachAudio:
		s.drawAudioFile(c, e, l, x, y)
	case attachCard:
		s.drawFileCard(c, e, l, x, y, w)
	}
	return p.h
}

func (s *Screen) drawImage(c *widget.Context, e *chat.Entry, l *entryLayout, p attachPlan, x, y float32) {
	msg := &e.Msg
	if p.imgW > 0 {
		r := geom.Rect{X: x, Y: y, W: p.imgW, H: p.imgH}
		c.Paint.DrawPicture(p.pic, r, imageRadius, false, c.Theme.Bg)
		if c.Hovered(r) {
			c.SetCursor(rl.MouseCursorPointingHand)
			if c.Clicked(r) {
				c.Claim()
				c.OpenModal(&lightbox{pic: p.pic, name: msg.AttachmentName, hash: msg.AttachmentHash, screen: s})
			}
		}
		y += p.imgH
	}
	y += attachBarTop
	name := msg.AttachmentName
	if name == "" {
		name = c.T("app.attachment")
	}
	c.Paint.Text(name, x, y, attachBarLine, barStyle, c.Theme.Muted)
	sizeX := x + c.Paint.TextWidth(name, barStyle) + 6.4
	c.Paint.Text(l.size, sizeX, y, attachBarLine, barStyle, theme.WithAlpha(c.Theme.Muted, 0.8))
	s.replaceButton(c, e, geom.Rect{X: sizeX + c.Paint.TextWidth(l.size, barStyle) + 6.4, Y: y + (attachBarLine-attachButtonH)/2, W: attachButtonW, H: attachButtonH})
}

func (s *Screen) iconFor(msg string, mediaType string) string {
	switch strings.ToLower(strings.TrimPrefix(filepath.Ext(msg), ".")) {
	case "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "iso", "dmg":
		return "file-zip"
	case "pdf":
		return "file-pdf"
	case "doc", "docx", "odt", "rtf", "pages":
		return "file-doc"
	case "xls", "xlsx", "ods", "numbers":
		return "file-xls"
	case "ppt", "pptx", "odp", "key":
		return "file-ppt"
	case "csv", "tsv":
		return "file-csv"
	case "txt", "md", "log", "ini", "cfg":
		return "file-text"
	case "js", "mjs", "ts", "tsx", "jsx", "json", "html", "css", "xml", "yml", "yaml", "toml", "py", "rb", "go", "rs", "java", "c", "h", "cpp", "hpp", "cs", "php", "sh", "bat", "ps1", "sql", "lua", "kt", "swift":
		return "file-code"
	case "mp3", "wav", "ogg", "oga", "flac", "m4a", "aac", "opus", "wma", "mid":
		return "file-audio"
	case "mp4", "mkv", "mov", "avi", "webm", "wmv", "flv", "m4v", "mpg", "mpeg":
		return "file-video"
	case "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tif", "tiff", "heic", "ico", "psd":
		return "file-image"
	}
	switch mediaType {
	case "image":
		return "file-image"
	case "video":
		return "file-video"
	case "audio":
		return "file-audio"
	}
	return "file"
}

func (s *Screen) drawFileCard(c *widget.Context, e *chat.Entry, l *entryLayout, x, y, w float32) {
	msg := &e.Msg
	card := geom.Rect{X: x, Y: y, W: min(cardMaxW, w), H: 2*(cardPadY+1) + max(cardIcon, cardNameLine+cardTextGap+cardSizeLine)}
	c.Paint.Fill(card, cardRadius, theme.WithAlpha(c.Theme.Tint, cardFillAlpha))
	c.Paint.Stroke(card, cardRadius, c.Hairline(), c.Theme.Border)
	inner := card.InsetAll(1 + cardPadY)
	inner.X = card.X + 1 + cardPadX
	c.Paint.Icon(s.iconFor(msg.AttachmentName, msg.MediaType), geom.Rect{X: inner.X, Y: inner.Y + (inner.H-cardIcon)/2, W: cardIcon, H: cardIcon}, c.Theme.Accent)
	tx := inner.X + cardIcon + cardGap
	end := card.Right() - 1 - cardPadX - attachButtonW
	name := msg.AttachmentName
	if name == "" {
		name = c.T("app.attachment")
	}
	top := inner.Y + (inner.H-(cardNameLine+cardTextGap+cardSizeLine))/2
	nameRect := geom.Rect{X: tx, Y: top, W: max(0, end-tx-8-s.replaceRoom(e)), H: cardNameLine}
	s.fileLink(c, e, nameRect, name, cardName)
	c.Paint.Text(l.size, tx, top+cardNameLine+cardTextGap, cardSizeLine, cardSizeSt, c.Theme.Muted)
	s.downloadButton(c, e, geom.Rect{X: end, Y: card.Y + (card.H-attachButtonH)/2, W: attachButtonW, H: attachButtonH})
	s.playButton(c, e, geom.Rect{X: end - attachButtonW - toolGap, Y: card.Y + (card.H-attachButtonH)/2, W: attachButtonW, H: attachButtonH})
	s.replaceButton(c, e, geom.Rect{X: end - attachButtonW - toolGap - videoRoom(e), Y: card.Y + (card.H-attachButtonH)/2, W: attachButtonW, H: attachButtonH})
}

// fileLink draws a file's name as a link that saves the file.
func (s *Screen) fileLink(c *widget.Context, e *chat.Entry, r geom.Rect, name string, style paint.TextStyle) {
	width := min(c.Paint.TextWidth(name, style), r.W)
	c.Paint.TextIn(r, name, r.X, r.Y, r.H, style, c.Theme.Accent)
	hit := geom.Rect{X: r.X, Y: r.Y, W: width, H: r.H}
	if c.Hovered(hit) {
		c.SetCursor(rl.MouseCursorPointingHand)
		c.Paint.Fill(geom.Rect{X: r.X, Y: r.Y + r.H/2 + 7.5, W: width, H: c.Hairline()}, 0, c.Theme.Accent)
		if c.Clicked(hit) {
			c.Claim()
			s.save(e.Msg.AttachmentHash, e.Msg.AttachmentName)
		}
	}
}

func (s *Screen) downloadButton(c *widget.Context, e *chat.Entry, r geom.Rect) {
	if c.Hovered(r) {
		c.SetCursor(rl.MouseCursorPointingHand)
		c.Paint.Fill(r, 5, theme.WithAlpha(c.Theme.Tint, 0.12))
		if c.Clicked(r) {
			c.Claim()
			s.save(e.Msg.AttachmentHash, e.Msg.AttachmentName)
		}
	}
	c.Paint.Icon("download-simple", geom.Rect{X: r.X + (r.W-attachIcon)/2, Y: r.Y + (r.H-attachIcon)/2, W: attachIcon, H: attachIcon}, c.Theme.Text)
}

func (s *Screen) drawTextCard(c *widget.Context, e *chat.Entry, l *entryLayout, p attachPlan, x, y, w float32) {
	msg := &e.Msg
	widest := float32(textCardMaxW)
	if dmOf(e) != nil {
		widest = cardMaxW
	}
	card := geom.Rect{X: x, Y: y, W: min(widest, w), H: p.h - attachTop}
	c.Paint.Fill(card, cardRadius, theme.WithAlpha(c.Theme.Tint, cardFillAlpha))
	edge := c.Hairline()
	hasMore := p.head.Ready && !p.head.Binary && (len(p.head.Lines) > p.rows || p.head.LeftLines > 0 || p.head.LeftBytes > 0)
	bodyH := 2*textBodyPadY + float32(p.rows)*textLine
	if hasMore {
		bodyH += textLeftTop + attachBarLine
	}
	body := geom.Rect{X: card.X + 1, Y: card.Y + 1, W: card.W - 2, H: bodyH}
	c.Paint.Fill(geom.Rect{X: body.X, Y: body.Y, W: body.W, H: body.H}, 0, theme.WithAlpha(rl.Black, textShade))
	c.Paint.Fill(geom.Rect{X: body.X, Y: body.Bottom(), W: body.W, H: edge}, 0, c.Theme.Border)
	if p.head.Ready && !p.head.Binary {
		lx := body.X + textBodyPadX
		clip := geom.Rect{X: lx, Y: body.Y, W: body.W - 2*textBodyPadX, H: body.H}
		for i := 0; i < p.rows && i < len(p.head.Lines); i++ {
			c.Paint.TextIn(clip, p.head.Lines[i], lx, body.Y+textBodyPadY+float32(i)*textLine, textLine, monoStyle, c.Theme.Text)
		}
		if hasMore {
			rest := len(p.head.Lines) - p.rows + p.head.LeftLines
			note := ""
			if p.head.LeftLines == 0 && p.head.LeftBytes > 0 && rest == 0 {
				note = c.T("attachment.bytes_left", "size", formatBytes(p.head.LeftBytes))
			} else {
				note = c.T("attachment.lines_left", "count", fmt.Sprint(rest))
			}
			c.Paint.Text("… ("+note+")", lx, body.Y+textBodyPadY+float32(p.rows)*textLine+textLeftTop, attachBarLine, leftStyle, c.Theme.Muted)
		}
	}
	foot := geom.Rect{X: card.X + 1, Y: body.Bottom() + edge, W: card.W - 2, H: card.Bottom() - 1 - body.Bottom() - edge}
	toggle := geom.Rect{X: foot.X + textFootPadX, Y: foot.Y + (foot.H-textToggle)/2, W: textToggle, H: textToggle}
	if p.head.Ready && !p.head.Binary {
		fill := theme.WithAlpha(c.Theme.Tint, 0.1)
		if c.Hovered(toggle) {
			c.SetCursor(rl.MouseCursorPointingHand)
			fill = theme.WithAlpha(c.Theme.Tint, 0.18)
			if c.Clicked(toggle) {
				c.Claim()
				s.chat.unfolded[msg.ID] = !s.chat.unfolded[msg.ID]
			}
		}
		c.Paint.Fill(toggle, 6, fill)
		icon := "caret-down"
		if s.chat.unfolded[msg.ID] {
			icon = "caret-up"
		}
		c.Paint.Icon(icon, geom.Rect{X: toggle.X + 8, Y: toggle.Y + 8, W: 16, H: 16}, c.Theme.Text)
	}
	tx := toggle.Right() + textFootGap
	end := foot.Right() - textFootPadX - attachButtonW
	top := foot.Y + textFootPadY
	name := msg.AttachmentName
	s.fileLink(c, e, geom.Rect{X: tx, Y: top, W: max(0, end-tx-8-s.replaceRoom(e)), H: textNameLine}, name, textName)
	c.Paint.Text(l.size, tx, top+textNameLine+cardTextGap, textSizeLine, sizeStyle, c.Theme.Muted)
	s.downloadButton(c, e, geom.Rect{X: end, Y: foot.Y + (foot.H-attachButtonH)/2, W: attachButtonW, H: attachButtonH})
	s.replaceButton(c, e, geom.Rect{X: end - attachButtonW - toolGap, Y: foot.Y + (foot.H-attachButtonH)/2, W: attachButtonW, H: attachButtonH})
	c.Paint.Stroke(card, cardRadius, edge, c.Theme.Border)
}

// lightbox shows a picture as large as the window allows.
type lightbox struct {
	pic    *paint.Picture
	name   string
	hash   string
	screen *Screen
}

func (l *lightbox) Draw(c *widget.Context, bounds geom.Rect) {
	c.Paint.Fill(bounds, 0, rl.NewColor(0, 0, 0, 220))
	if pw, ph, ok := l.pic.Size(); ok {
		avail := bounds.InsetAll(48)
		scale := min(1, avail.W/float32(pw), avail.H/float32(ph))
		r := geom.Rect{W: float32(pw) * scale, H: float32(ph) * scale}
		r.X, r.Y = bounds.X+(bounds.W-r.W)/2, bounds.Y+(bounds.H-r.H)/2
		c.Paint.DrawPicture(l.pic, r, 0, false, rl.Black)
	}
	save := &widget.Button{Icon: "download-simple", Variant: widget.Ghost, Small: true, OnClick: func() { l.screen.save(l.hash, l.name) }}
	size := save.Measure(c, 0)
	button := geom.Rect{X: bounds.Right() - size.W - 16, Y: bounds.Y + 16, W: size.W, H: size.H}
	save.Draw(c, button)
	c.Layer(l)
	if c.EscapeFor(l) || (c.Clicked(bounds) && !c.Hovered(button)) {
		c.CloseModal()
	}
}

func (s *Screen) isMine(e *chat.Entry) bool {
	return e.Msg.UserID == s.Session.State().Me.ID && dmOf(e) == nil
}

// replaceRoom is the width a message's replace button takes beside a file's name.
func (s *Screen) replaceRoom(e *chat.Entry) float32 {
	if s.isMine(e) {
		return videoRoom(e) + attachButtonW + toolGap
	}
	return videoRoom(e)
}

// replaceButton gives the person's own message another file.
func (s *Screen) replaceButton(c *widget.Context, e *chat.Entry, r geom.Rect) {
	if !s.isMine(e) {
		return
	}
	if c.Hovered(r) {
		c.SetCursor(rl.MouseCursorPointingHand)
		c.Paint.Fill(r, 5, theme.WithAlpha(c.Theme.Tint, 0.12))
		if c.Clicked(r) {
			c.Claim()
			s.replaceFile(c, e.Msg.ID)
		}
	}
	c.Paint.Icon("pencil-simple", geom.Rect{X: r.X + (r.W-attachIcon)/2, Y: r.Y + (r.H-attachIcon)/2, W: attachIcon, H: attachIcon}, c.Theme.Text)
}
