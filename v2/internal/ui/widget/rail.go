package widget

import (
	"image/color"
	"math"
	"strconv"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/theme"
)

// RailState is whether a server on the rail can be reached and signed in to.
type RailState uint8

const (
	RailUp RailState = iota
	RailOffline
	// RailLocked is a server with no sign-in to use: opening it asks for the password.
	RailLocked
)

type RailServer struct {
	URL     string
	Name    string
	Current bool
	State   RailState
	Logo    ServerLogo
	// Unread says there is news on a server that is not open, Mentions how many messages name the person there.
	Unread   bool
	Mentions int
	// Voice says somebody is in one of its voice channels, InCall that the person's own call is on it.
	Voice  bool
	InCall bool
}

// ServerRail is the strip down the left edge: private messages, one bubble per saved server, and a button to add one.
type ServerRail struct {
	HomeCurrent  bool
	HomeDisabled bool
	// HomeUnread is how many private messages wait, on a badge over the first bubble.
	HomeUnread int
	Servers    []RailServer
	OnHome     func()
	OnAdd      func()
	OnSelect   func(url string)
	// OnMenu is told where a server was right-clicked, in window coordinates.
	OnMenu func(url string, x, y float32)
	// OnMove is told a server was dragged before (or after) another.
	OnMove func(url, to string, after bool)
	// Card is asked for what a server's card says, only while the pointer rests on its bubble.
	Card func(url string) *ServerCard

	scroll Scroll
	column railColumn
	eases  map[string]*railEase
	rects  []geom.Rect
	view   geom.Rect
	press  railPress
	hover  railHover
	ghost  func()
	ghostC *Context
}

type railEase struct{ shape, pill Ease }

type railPress struct {
	active   bool
	dragging bool
	url      string
	x, y     float32
	over     string
	after    bool
}

type railHover struct {
	url   string
	since time.Time
}

const (
	RailWidth       = 72
	railItem        = 48
	railGap         = 8
	railPaddingY    = 12
	railSeparatorW  = 32
	railSeparatorH  = 2
	railRadius      = railItem / 2
	railRadiusHover = 16
	railPillWidth   = 4
	railPillOpen    = 32
	railPillDot     = 8
	railMorph       = 0.15
	railBadgeHeight = 18
	railBadgeRing   = 3
	railBadgeSize   = 11
	railInitialSize = 18
	railHomeIcon    = 24
	railPlusLength  = 20
	railPlusBar     = 3
	railDash        = 3
	railDashGap     = 1.4
	railDisabled    = 0.4
	railFaded       = 0.5
	railDragged     = 0.35
	railGhost       = 0.92
	railGhostScale  = 1.06
	railDragPixels  = 5
	railEdgeBand    = 28
	railEdgeStep    = 8
	railCardDelay   = 450 * time.Millisecond
	railVoiceBox    = 24
	railVoiceRing   = 3
	railVoiceIcon   = 14
	railVoiceLeft   = 6
	railVoiceTop    = 5
	railCallRing    = 2
	railDropBar     = 3
	railDropInset   = 4
	railDropOff     = 6
)

func (r *ServerRail) Measure(_ *Context, _ float32) geom.Size { return geom.Size{W: RailWidth} }

func (r *ServerRail) Draw(c *Context, bounds geom.Rect) {
	c.Paint.Fill(bounds, 0, c.Theme.Bg)
	c.Paint.Fill(geom.Rect{X: bounds.Right() - c.Hairline(), Y: bounds.Y, W: c.Hairline(), H: bounds.H}, 0, c.Theme.Border)
	r.column.rail = r
	r.scroll.Child = &r.column
	r.rects = r.rects[:0]
	r.view = bounds
	r.scroll.Draw(c, bounds)
	r.interact(c, bounds)
}

type railColumn struct{ rail *ServerRail }

func (col railColumn) Measure(_ *Context, _ float32) geom.Size {
	items := len(col.rail.Servers) + 2
	return geom.Size{W: RailWidth, H: 2*railPaddingY + float32(items)*railItem + float32(items+1)*railGap + railSeparatorH - railGap}
}

func (col railColumn) Draw(c *Context, bounds geom.Rect) {
	r := col.rail
	x := bounds.X + (RailWidth-railItem)/2
	y := bounds.Y + railPaddingY
	item := func() geom.Rect {
		rect := geom.Rect{X: x, Y: y, W: railItem, H: railItem}
		y += railItem + railGap
		return rect
	}

	r.drawItem(c, "home", item(), railButton{icon: "chat-bubble", current: r.HomeCurrent, disabled: r.HomeDisabled, badge: r.HomeUnread, onClick: r.OnHome})
	c.Paint.Fill(geom.Rect{X: x + (railItem-railSeparatorW)/2, Y: y, W: railSeparatorW, H: railSeparatorH}, railSeparatorH/2, c.Theme.Border)
	y += railSeparatorH + railGap
	for i := range r.Servers {
		server := &r.Servers[i]
		rect := item()
		r.rects = append(r.rects, rect)
		r.drawItem(c, server.URL, rect, railButton{server: server, current: server.Current})
	}
	r.drawItem(c, "add", item(), railButton{add: true, onClick: r.OnAdd})
}

type railButton struct {
	icon     string
	server   *RailServer
	add      bool
	current  bool
	disabled bool
	badge    int
	onClick  func()
	// dimmed is the bubble being carried; drop is where it would land, -1 before this one, 1 after.
	dimmed bool
	drop   int
}

func (r *ServerRail) easeFor(key string) *railEase {
	if r.eases == nil {
		r.eases = map[string]*railEase{}
	}
	e := r.eases[key]
	if e == nil {
		e = &railEase{}
		r.eases[key] = e
	}
	return e
}

func (r *ServerRail) drawItem(c *Context, key string, rect geom.Rect, b railButton) {
	hovered := !b.disabled && c.Hovered(rect)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	if b.server == nil && hovered && c.Clicked(rect) && b.onClick != nil {
		c.Claim()
		b.onClick()
	}
	if b.server != nil {
		b.dimmed = r.press.dragging && r.press.url == b.server.URL
		if r.press.dragging && r.press.over == b.server.URL {
			b.drop = -1
			if r.press.after {
				b.drop = 1
			}
		}
	}

	e := r.easeFor(key)
	lit := float32(0)
	if hovered || b.current {
		lit = 1
	}
	t := Smooth(e.shape.Toward(c, lit, railMorph))
	radius := railRadius + (railRadiusHover-railRadius)*t
	opacity := float32(1)
	if b.dimmed {
		opacity = railDragged
	}
	r.drawBubble(c, rect, radius, t, opacity, b)
	r.drawPill(c, rect, e, b)
	if b.drop != 0 {
		bar := geom.Rect{X: rect.X + railDropInset, Y: rect.Y - railDropOff, W: rect.W - 2*railDropInset, H: railDropBar}
		if b.drop > 0 {
			bar.Y = rect.Bottom() + railDropOff - railDropBar
		}
		c.Paint.Fill(bar, railDropBar/2, c.Theme.Accent)
	}
}

func (r *ServerRail) drawBubble(c *Context, rect geom.Rect, radius, t, opacity float32, b railButton) {
	p, th := c.Paint, c.Theme
	if b.disabled {
		opacity = railDisabled
	}
	switch {
	case b.add:
		fill := theme.Mix(color.RGBA{}, th.Live, t)
		p.Fill(rect, radius, fill)
		p.DashedRoundRect(rect, radius, c.Hairline(), railDash, railDashGap, th.BorderStrong)
		ink := theme.Mix(th.Live, color.RGBA{R: 255, G: 255, B: 255, A: 255}, t)
		cx, cy := rect.X+rect.W/2, rect.Y+rect.H/2
		p.Fill(geom.Rect{X: cx - railPlusLength/2, Y: cy - railPlusBar/2, W: railPlusLength, H: railPlusBar}, 0, ink)
		p.Fill(geom.Rect{X: cx - railPlusBar/2, Y: cy - railPlusLength/2, W: railPlusBar, H: railPlusLength}, 0, ink)
	case b.icon != "":
		p.Fill(rect, radius, theme.WithAlpha(theme.Mix(th.Surface2, th.Accent, t), opacity))
		side := geom.Rect{X: rect.X + (rect.W-railHomeIcon)/2, Y: rect.Y + (rect.H-railHomeIcon)/2, W: railHomeIcon, H: railHomeIcon}
		p.Icon(b.icon, side, theme.WithAlpha(th.Text, opacity))
		if b.badge > 0 {
			drawRailBadge(c, rect, BadgeCount(b.badge), th.Danger, color.RGBA{R: 255, G: 255, B: 255, A: 255})
		}
	default:
		r.drawServer(c, rect, radius, t, opacity, b.server)
	}
}

func (r *ServerRail) drawServer(c *Context, rect geom.Rect, radius, t, opacity float32, s *RailServer) {
	p, th := c.Paint, c.Theme
	p.Fill(rect, radius, theme.WithAlpha(theme.Mix(th.Surface2, th.Accent, t), opacity))
	face := opacity
	if s.State != RailUp {
		face *= railFaded
	}
	if !c.DrawServerLogoAlpha(s.Logo, rect, radius, th.Bg, face) {
		r.drawInitial(c, rect, s, face)
	}
	if s.InCall {
		p.Stroke(rect.InsetAll(-railCallRing), radius+railCallRing, railCallRing, theme.WithAlpha(th.Live, opacity))
	}
	if s.Voice && !s.Current && !s.InCall {
		drawRailVoice(c, rect, opacity)
	}
	switch {
	case s.Mentions > 0 && !s.Current:
		drawRailBadge(c, rect, BadgeCount(s.Mentions), th.Danger, color.RGBA{R: 255, G: 255, B: 255, A: 255})
	case s.State == RailLocked:
		drawRailBadge(c, rect, "!", th.Warn, color.RGBA{A: 255})
	}
}

func (r *ServerRail) drawInitial(c *Context, rect geom.Rect, s *RailServer, alpha float32) {
	style := paint.TextStyle{Size: railInitialSize, Weight: paint.Bold}
	initial := initialM.of(s.Name)
	if initial == "" {
		initial = "?"
	}
	line := float32(railInitialSize * 1.5)
	c.Paint.Text(initial, rect.X+(rect.W-c.Paint.TextWidth(initial, style))/2, rect.Y+(rect.H-line)/2, line, style, theme.WithAlpha(c.Theme.Text, alpha))
}

func drawRailVoice(c *Context, item geom.Rect, opacity float32) {
	box := geom.Rect{X: item.Right() + railVoiceLeft - railVoiceBox, Y: item.Y - railVoiceTop, W: railVoiceBox, H: railVoiceBox}
	c.Paint.Fill(box, railVoiceBox/2, theme.WithAlpha(c.Theme.Bg, opacity))
	c.Paint.Fill(box.InsetAll(railVoiceRing), (railVoiceBox-2*railVoiceRing)/2, theme.WithAlpha(c.Theme.Live, opacity))
	icon := geom.Rect{X: box.X + (box.W-railVoiceIcon)/2, Y: box.Y + (box.H-railVoiceIcon)/2, W: railVoiceIcon, H: railVoiceIcon}
	c.Paint.Icon("speaker-high", icon, color.RGBA{R: 255, G: 255, B: 255, A: uint8(255 * opacity)})
}

func drawRailBadge(c *Context, item geom.Rect, text string, fill, ink color.RGBA) {
	style := paint.TextStyle{Size: railBadgeSize, Weight: paint.Bold}
	width := max(railBadgeHeight, c.Paint.TextWidth(text, style)+10)
	box := geom.Rect{X: item.Right() + 4 - width, Y: item.Bottom() + 4 - railBadgeHeight, W: width, H: railBadgeHeight}
	c.Paint.Fill(box.InsetAll(-railBadgeRing), railBadgeHeight/2+railBadgeRing, c.Theme.Bg)
	c.Paint.Fill(box, railBadgeHeight/2, fill)
	line := float32(railBadgeSize)
	c.Paint.Text(text, box.X+(box.W-c.Paint.TextWidth(text, style))/2, box.Y+(box.H-line)/2, line, style, ink)
}

// drawPill is the mark on the left edge: tall for the open server, a dot for one with news.
func (r *ServerRail) drawPill(c *Context, rect geom.Rect, e *railEase, b railButton) {
	target := float32(0)
	switch {
	case b.current:
		target = railPillOpen
	case b.server != nil && b.server.Unread:
		target = railPillDot
	}
	height := e.pill.Toward(c, target/railPillOpen, railMorph) * railPillOpen
	if height <= 0 {
		return
	}
	edge := rect.X - (RailWidth-railItem)/2
	c.Paint.PushClip(geom.Rect{X: edge, Y: rect.Y - railPillOpen, W: railPillWidth, H: rect.H + 2*railPillOpen})
	c.Paint.Fill(geom.Rect{X: edge - railPillWidth, Y: rect.Y + (rect.H-height)/2, W: 2 * railPillWidth, H: height}, railPillWidth, c.Theme.Text)
	c.Paint.PopClip()
}

func BadgeCount(n int) string {
	if n > 99 {
		return "99+"
	}
	return strconv.Itoa(n)
}

// interact is what the pointer does to the server bubbles: choose, open the menu, carry one to another place, rest on one for its card.
func (r *ServerRail) interact(c *Context, bounds geom.Rect) {
	in := c.In
	over := -1
	if bounds.Contains(in.MouseX, in.MouseY) {
		for i, rect := range r.rects {
			if c.Hovered(rect) {
				over = i
			}
		}
	}
	if r.press.dragging {
		r.carry(c, bounds)
		return
	}
	switch {
	case over >= 0 && in.RightPressed:
		c.Claim()
		r.hover = railHover{}
		if r.OnMenu != nil {
			r.OnMenu(r.Servers[over].URL, in.MouseX, in.MouseY)
		}
	case over >= 0 && in.Pressed && !c.Claimed():
		c.Claim()
		r.hover = railHover{}
		r.press = railPress{active: true, url: r.Servers[over].URL, x: in.MouseX, y: in.MouseY}
	}
	if r.press.active {
		r.follow(c, over)
		return
	}
	r.rest(c, over)
}

// follow watches a press on a bubble: let go over it is a choice, moved far enough is the start of a carry.
func (r *ServerRail) follow(c *Context, over int) {
	in := c.In
	switch {
	case in.Released || !in.Down:
		if over >= 0 && r.Servers[over].URL == r.press.url && r.OnSelect != nil {
			r.OnSelect(r.press.url)
		}
		r.press = railPress{}
	case math.Hypot(float64(in.MouseX-r.press.x), float64(in.MouseY-r.press.y)) >= railDragPixels:
		r.press.dragging = true
		r.hover = railHover{}
		r.ghostC = c
		if r.ghost == nil {
			r.ghost = r.drawGhost
		}
		redraw.Request()
	}
}

// carry moves the bubble in the hand: it follows the pointer, the rail scrolls near its edge, and the nearest bubble says where it would land.
func (r *ServerRail) carry(c *Context, bounds geom.Rect) {
	in := c.In
	p := &r.press
	c.SetCursor(rl.MouseCursorResizeAll)
	if in.Escape {
		c.Claim()
		*p = railPress{}
		return
	}
	if !in.Down {
		if p.over != "" && r.OnMove != nil {
			r.OnMove(p.url, p.over, p.after)
		}
		*p = railPress{}
		return
	}
	switch {
	case in.MouseY < bounds.Y+railEdgeBand:
		r.scroll.ScrollBy(-railEdgeStep)
		redraw.Request()
	case in.MouseY > bounds.Bottom()-railEdgeBand:
		r.scroll.ScrollBy(railEdgeStep)
		redraw.Request()
	}
	best, nearest := float32(math.MaxFloat32), -1
	for i, rect := range r.rects {
		if r.Servers[i].URL == p.url {
			continue
		}
		gap := float32(0)
		switch {
		case in.MouseY < rect.Y:
			gap = rect.Y - in.MouseY
		case in.MouseY > rect.Bottom():
			gap = in.MouseY - rect.Bottom()
		}
		if gap < best {
			best, nearest = gap, i
		}
	}
	p.over, p.after = "", false
	if nearest >= 0 {
		rect := r.rects[nearest]
		p.over, p.after = r.Servers[nearest].URL, in.MouseY > rect.Y+rect.H/2
	}
	c.Overlay(r.ghost)
}

func (r *ServerRail) drawGhost() {
	c := r.ghostC
	for i := range r.Servers {
		if r.Servers[i].URL != r.press.url {
			continue
		}
		size := float32(railItem * railGhostScale)
		rect := geom.Rect{X: c.In.MouseX - size/2, Y: c.In.MouseY - size/2, W: size, H: size}
		c.Paint.Shadow(rect, size/2, 8, 22, color.RGBA{A: 128})
		r.drawBubble(c, rect, size/2, 0, railGhost, railButton{server: &r.Servers[i]})
	}
}

// rest shows a server's card once the pointer has rested on its bubble for a moment.
func (r *ServerRail) rest(c *Context, over int) {
	in := c.In
	if over < 0 || in.Escape || in.Wheel != 0 || r.Card == nil {
		r.hover = railHover{}
		return
	}
	url := r.Servers[over].URL
	if r.hover.url != url {
		r.hover = railHover{url: url, since: time.Now()}
	}
	if left := railCardDelay - time.Since(r.hover.since); left > 0 {
		redraw.After(left)
		return
	}
	if card := r.Card(url); card != nil {
		card.Draw(c, r.rects[over])
	}
}
