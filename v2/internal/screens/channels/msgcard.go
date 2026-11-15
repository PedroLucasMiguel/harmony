package channels

import (
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/markdown"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	mcPadY       = 9.6
	mcPadX       = 11.2
	mcGap        = 9.6
	mcAvatar     = 25.6
	mcAvatarFont = 11.2
	mcAvatarTop  = 1.68
	mcRadius     = 8
	mcHeadLine   = 21
	mcWhenLine   = 18
	mcWhenDrop   = 2.2
	mcWhenGap    = 8
	mcHover      = 0.06
	mcEdge       = 0.12
	mcFileLine   = 21
	mcFileIcon   = 16
	mcToolInset  = 6.4
	mcToolH      = 30.4
	mcToolPadX   = 11.2
	mcToolGap    = 4
	mcToolRadius = 6
	mcToolHover  = 0.14
)

var (
	mcName  = paint.TextStyle{Size: 14, Weight: paint.Bold}
	mcWhen  = paint.TextStyle{Size: 12, Weight: paint.Regular}
	mcTool  = paint.TextStyle{Size: 13.12, Weight: paint.Regular}
	mcFileS = paint.TextStyle{Size: 14, Weight: paint.Regular}
)

// msgCard is a message set in a list of messages: who and when, the words, and a click that goes to it. The pins, the
// stars and the search results are lists of these.
type msgCard struct {
	msg     hclient.ChatMessage
	who     string
	when    string
	where   string
	text    *widget.RichText
	width   float32
	zoom    float32
	height  float32
	current bool
	jump    func()
	// action is the cross in the corner (let a pin or a star go); empty when the card has none.
	action func()
}

func mcTextWidth(c *widget.Context, width float32) float32 {
	return width - 2*(mcPadX+c.Hairline()) - mcAvatar - mcGap
}

func (s *Screen) newCard(c *widget.Context, m model, msg hclient.ChatMessage, where string, width float32, brief bool) *msgCard {
	card := &msgCard{msg: msg, where: where}
	card.who = s.nameOf(m, msg.UserID, msg.Nickname)
	card.when = shortStamp(c, msg.CreatedAt)
	if at, now := time.UnixMilli(msg.CreatedAt), time.Now(); brief && at.Year() == now.Year() && at.YearDay() == now.YearDay() {
		card.when = messageTime(c, msg.CreatedAt, true)
	}
	card.layout(s, c, m, width)
	return card
}

func (k *msgCard) layout(s *Screen, c *widget.Context, m model, width float32) {
	k.width, k.zoom = width, c.Paint.Zoom
	k.text = nil
	k.height = 2*(mcPadY+c.Hairline()) + mcHeadLine
	if k.msg.Body != "" {
		blocks := markdown.Parse(k.msg.Body)
		k.text = widget.NewRichTextWith(c, blocks, mcTextWidth(c, width), s.mentioned(m), emojiFinder(s.Session.Chat().Emojis()))
		k.height += k.text.Height
	}
	if k.msg.AttachmentHash != "" {
		k.height += mcFileLine
	}
}

func (k *msgCard) fits(c *widget.Context, width float32) bool {
	return k.width == width && k.zoom == c.Paint.Zoom
}

// shortStamp is a date and a time of day in the short form of the language.
func shortStamp(c *widget.Context, ms int64) string {
	layout := "1/2/06, 3:04 PM"
	if c.Strings.Code() != "en" {
		layout = "02/01/06, 15:04"
	}
	return time.UnixMilli(ms).Format(layout)
}

type toolPress int

const (
	toolNone toolPress = iota
	toolJump
	toolAction
)

// Draw paints the card; view is the part of the list that shows, which is where the mouse may touch it.
func (k *msgCard) Draw(s *Screen, c *widget.Context, r, view geom.Rect) {
	shown := r.Intersect(view)
	hovered := shown.W > 0 && shown.H > 0 && c.Hovered(shown)
	edge := c.Hairline()
	if hovered {
		c.Paint.Fill(r, mcRadius, theme.WithAlpha(c.Theme.Tint, mcHover))
	}
	border := theme.WithAlpha(c.Theme.Tint, mcEdge)
	if k.current {
		border = c.Theme.Accent
	}
	c.Paint.Stroke(r, mcRadius, edge, border)

	x, y := r.X+mcPadX+edge, r.Y+mcPadY+edge
	widget.Avatar{Name: k.who, Size: mcAvatar, Font: mcAvatarFont}.Draw(c, geom.Rect{X: x, Y: y + mcAvatarTop, W: mcAvatar, H: mcAvatar})
	x += mcAvatar + mcGap
	c.Paint.Text(k.who, x, y, mcHeadLine, mcName, c.Theme.Text)
	at := x + c.Paint.TextWidth(k.who, mcName) + mcWhenGap
	c.Paint.Text(k.when, at, y+mcWhenDrop, mcWhenLine, mcWhen, theme.WithAlpha(c.Theme.Text, 0.6))
	if k.where != "" {
		at += c.Paint.TextWidth(k.when, mcWhen) + mcWhenGap
		c.Paint.TextIn(geom.Rect{X: at, Y: y, W: max(0, r.Right()-mcPadX-at), H: mcHeadLine}, k.where, at, y+mcWhenDrop, mcWhenLine, mcWhen, c.Theme.Accent)
	}
	y += mcHeadLine
	if k.text != nil {
		k.text.Draw(c, x, y)
		y += k.text.Height
	}
	if k.msg.AttachmentHash != "" {
		c.Paint.Icon(s.iconFor(k.msg.AttachmentName, k.msg.MediaType), geom.Rect{X: x, Y: y + (mcFileLine-mcFileIcon)/2, W: mcFileIcon, H: mcFileIcon}, c.Theme.Accent)
		name := k.msg.AttachmentName
		if name == "" {
			name = c.T("app.attachment_2")
		}
		c.Paint.TextIn(geom.Rect{X: x, Y: y, W: max(0, r.Right()-mcPadX-x), H: mcFileLine}, name, x+mcFileIcon+4.8, y, mcFileLine, mcFileS, c.Theme.Muted)
	}

	pressed := toolNone
	if hovered {
		pressed = k.drawTools(c, r)
	}
	if pressed == toolNone && hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(shown) {
			c.Claim()
			k.jump()
		}
	}
	switch pressed {
	case toolJump:
		k.jump()
	case toolAction:
		k.action()
	}
}

// drawTools paints the buttons in the card's corner while the mouse is over it, and says which one was pressed.
func (k *msgCard) drawTools(c *widget.Context, r geom.Rect) toolPress {
	edge := c.Hairline()
	jump := c.T("app.jump")
	jumpW := c.Paint.TextWidth(jump, mcTool) + 2*(mcToolPadX+edge)
	width := jumpW
	if k.action != nil {
		width += mcToolGap + mcToolH
	}
	x, y := r.Right()-edge-mcToolInset-width, r.Y+edge+mcToolInset
	pressed := toolNone
	button := geom.Rect{X: x, Y: y, W: jumpW, H: mcToolH}
	hot := c.Hovered(button)
	c.Paint.Fill(button, mcToolRadius, c.Theme.Surface2)
	if hot {
		c.Paint.Fill(button, mcToolRadius, theme.WithAlpha(c.Theme.Tint, mcToolHover))
	}
	c.Paint.Stroke(button, mcToolRadius, edge, c.Theme.Border)
	c.Paint.Text(jump, button.X+(button.W-c.Paint.TextWidth(jump, mcTool))/2, y+(mcToolH-mcTool.Size*1.5)/2, mcTool.Size*1.5, mcTool, c.Theme.Text)
	if hot {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.In.Pressed {
			c.Claim()
			pressed = toolJump
		}
	}
	if k.action == nil {
		return pressed
	}
	cross := geom.Rect{X: button.Right() + mcToolGap, Y: y, W: mcToolH, H: mcToolH}
	hot = c.Hovered(cross)
	c.Paint.Fill(cross, mcToolRadius, c.Theme.Surface2)
	if hot {
		c.Paint.Fill(cross, mcToolRadius, theme.WithAlpha(c.Theme.Tint, mcToolHover))
	}
	c.Paint.Stroke(cross, mcToolRadius, edge, c.Theme.Border)
	c.Paint.Icon("x", geom.Rect{X: cross.X + (mcToolH-14)/2, Y: cross.Y + (mcToolH-14)/2, W: 14, H: 14}, c.Theme.Text)
	if hot {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.In.Pressed {
			c.Claim()
			pressed = toolAction
		}
	}
	return pressed
}
