package widget

import (
	"image/color"
	"strconv"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	serverCardWidth     = 240
	serverCardMargin    = 8
	serverCardGap       = 10
	serverCardRadius    = 12
	serverCardBannerAR  = 3
	serverCardPadX      = 14.4
	serverCardPadY      = 12.8
	serverCardFace      = 56
	serverCardFaceRing  = 3
	serverCardFaceR     = 12
	serverCardFaceText  = 22
	serverCardNameSize  = 16
	serverCardHeadGap   = 11.2
	serverCardLift      = 28
	serverCardVoiceGap  = 5.6
	serverCardLabelSize = 11.52
	serverCardTiny      = 22.4
	serverCardTinyText  = 10
	serverCardTinyGap   = 4.8
	serverCardMore      = 12.8
	serverCardMaxFaces  = 8
	serverCardShadowA   = 128
)

// ServerCardPerson is somebody in a voice channel on the server, by the picture their account has there.
type ServerCardPerson struct {
	Name string
	Hash string
	Src  paint.Sizer
}

// ServerCard is the card that opens when the pointer rests on a server's bubble in the rail: its picture, its name and, when its
// owner has set one, its banner and who is in a voice channel. It never takes the pointer; the rail decides when to show it.
type ServerCard struct {
	Name   string
	Logo   ServerLogo
	Banner ServerLogo
	// Voice is who is in a voice channel there, each person once.
	Voice []ServerCardPerson
}

func (k *ServerCard) bannerHeight(width float32) float32 {
	if k.Banner.Hash == "" {
		return 0
	}
	return width / serverCardBannerAR
}

func (k *ServerCard) voiceHeight() float32 {
	if len(k.Voice) == 0 {
		return 0
	}
	return serverCardLabelSize*1.5 + serverCardVoiceGap + serverCardTiny
}

func (k *ServerCard) height(c *Context, width float32) float32 {
	banner := k.bannerHeight(width - 2*c.Hairline())
	voice := k.voiceHeight()
	head := float32(2*serverCardPadY + serverCardFace)
	if banner > 0 {
		head = serverCardFace + 2*serverCardFaceRing - serverCardLift + 6.4 + serverCardNameSize*1.5 + serverCardPadY
	}
	h := banner + head + 2*c.Hairline()
	if voice > 0 {
		h += voice + serverCardPadY
	}
	return h
}

// Draw shows the card to the right of anchor, the rectangle of the bubble, over everything.
func (k *ServerCard) Draw(c *Context, anchor geom.Rect) {
	c.Overlay(func() { k.paint(c, anchor) })
}

func (k *ServerCard) paint(c *Context, anchor geom.Rect) {
	width := float32(min(serverCardWidth, c.Viewport.W-96))
	height := k.height(c, width)
	x := anchor.Right() + serverCardGap
	y := min(max(serverCardMargin, anchor.Y+anchor.H/2-height/2), c.Viewport.H-height-serverCardMargin)
	box := geom.Rect{X: x, Y: y, W: width, H: height}
	edge := c.Hairline()
	c.Paint.Shadow(box, serverCardRadius, 8, 28, color.RGBA{A: serverCardShadowA})
	c.Paint.Fill(box, serverCardRadius, c.Theme.Surface2)
	inner := box.InsetAll(edge)
	top := inner.Y
	banner := k.bannerHeight(inner.W)
	if banner > 0 {
		r := geom.Rect{X: inner.X, Y: top, W: inner.W, H: banner}
		if !c.DrawServerLogo(k.Banner, r, 0, c.Theme.Surface2) {
			c.Paint.Fill(r, 0, theme.WithAlpha(c.Theme.Accent, 0.12))
		}
		c.Paint.TopCorners(r, serverCardRadius, c.Theme.Bg)
		top += banner
	}
	face := geom.Rect{X: inner.X + serverCardPadX, Y: top + serverCardPadY, W: serverCardFace, H: serverCardFace}
	nameX := face.Right() + serverCardHeadGap
	nameY := face.Y + (serverCardFace-serverCardNameSize*1.5)/2
	style := paint.TextStyle{Size: serverCardNameSize, Weight: paint.Bold}
	next := face.Bottom() + serverCardPadY
	if banner > 0 {
		face.Y = top - serverCardLift + serverCardFaceRing
		c.Paint.Fill(face.InsetAll(-serverCardFaceRing), serverCardFaceR+serverCardFaceRing, c.Theme.Surface2)
		nameX, nameY = inner.X+serverCardPadX, face.Bottom()+serverCardFaceRing+6.4
		next = nameY + serverCardNameSize*1.5 + serverCardPadY
	}
	c.ServerTile(face, k.Name, k.Logo, serverCardFaceR, serverCardFaceText, c.Theme.Surface2)
	c.Paint.TextIn(geom.Rect{X: nameX, Y: nameY, W: inner.Right() - serverCardPadX - nameX, H: serverCardNameSize * 1.5}, k.Name, nameX, nameY, serverCardNameSize*1.5, style, c.Theme.Text)
	if len(k.Voice) > 0 {
		k.drawVoice(c, inner.X+serverCardPadX, next, inner.W-2*serverCardPadX)
	}
}

func (k *ServerCard) drawVoice(c *Context, x, y, width float32) {
	label := paint.TextStyle{Size: serverCardLabelSize, Weight: paint.Regular, Spacing: serverCardLabelSize * 0.06}
	c.Paint.Text(Upper(c.T("rail.card_in_voice")), x, y, serverCardLabelSize*1.5, label, c.Theme.Muted)
	y += serverCardLabelSize*1.5 + serverCardVoiceGap
	shown := min(len(k.Voice), serverCardMaxFaces)
	for i := range shown {
		p := k.Voice[i]
		Avatar{Name: p.Name, Hash: p.Hash, Source: p.Src, Size: serverCardTiny, Font: serverCardTinyText}.Draw(c, geom.Rect{X: x + float32(i)*(serverCardTiny+serverCardTinyGap), Y: y, W: serverCardTiny, H: serverCardTiny})
	}
	if more := len(k.Voice) - shown; more > 0 {
		text := "+" + strconv.Itoa(more)
		style := paint.TextStyle{Size: serverCardMore, Weight: paint.Regular}
		c.Paint.Text(text, x+float32(shown)*(serverCardTiny+serverCardTinyGap), y+(serverCardTiny-serverCardMore*1.5)/2, serverCardMore*1.5, style, c.Theme.Muted)
	}
}
