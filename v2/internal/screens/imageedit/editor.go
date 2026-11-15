// Package imageedit is the window a picture is cropped in before it becomes a profile picture, a banner, a server's picture or
// an emoji: the picture behind a mask in the shape it will be seen in, moved by dragging, zoomed by the wheel or the slider, and
// turned. What is inside the mask is what is kept.
package imageedit

import (
	"fmt"
	"image/color"
	"math"
	"sync/atomic"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/imagecrop"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

// Purpose is what the picture is for, which sets the kind of cut and the words.
type Purpose int

const (
	ProfilePicture Purpose = iota
	ProfileBanner
	ServerLogo
	ServerBanner
	EmojiPicture
)

func (p Purpose) kind() imagecrop.Kind {
	switch p {
	case ProfileBanner, ServerBanner:
		return imagecrop.Banner
	case ServerLogo:
		return imagecrop.Logo
	case EmojiPicture:
		return imagecrop.Emoji
	}
	return imagecrop.Avatar
}

func (p Purpose) words() (title, hint string) {
	switch p {
	case ProfileBanner:
		return "image_editor.title_banner", "image_editor.hint_banner"
	case ServerLogo, EmojiPicture:
		return "image_editor.title_logo", "image_editor.hint_logo"
	case ServerBanner:
		return "image_editor.title_server_banner", "image_editor.hint_server_banner"
	}
	return "image_editor.title_avatar", "image_editor.hint"
}

const (
	cardMaxWidth    = 420
	cardMargin      = 12
	cardPadX        = 19.2
	cardPadTop      = 16
	cardPadBottom   = 17.6
	cardGap         = 11.2
	cardRadius      = 12
	backdropAlpha   = 153
	titleSize       = 17
	hintSize        = 13.6
	labelWidth      = 67.2
	labelSize       = 13.6
	labelAlpha      = 0.8
	stageRadius     = 8
	bannerStageW    = 380
	avatarStageW    = 320
	stageMinW       = 220
	stageSideGutter = 56
	maskShareBanner = 0.86
	maskShareSquare = 0.72
	bannerExtra     = 70
	maskEdge        = 2
	maskEdgeAlpha   = 0.9
	dimAlpha        = 158
	stripAlpha      = 0.7
	wheelZoom       = 0.15
	keyStep         = 6
	keyStepFast     = 24
	zoomSteps       = 1000
	maxWidthShare   = 0.94
)

var pictureSerial atomic.Uint64

// Options is what to edit and what to do with it.
type Options struct {
	Purpose Purpose
	Source  *imagecrop.Source
	Data    []byte
	// OnDone gets the cut picture, from the interface's thread; OnCancel is called when the window is closed without one.
	OnDone   func(imagecrop.Result)
	OnCancel func()
}

// Editor is the cropping window; open it with Context.OpenModal.
type Editor struct {
	opt   Options
	kind  imagecrop.Kind
	key   string
	pic   *paint.Picture
	mask  imagecrop.Mask
	stage geom.Size
	place imagecrop.Placement
	iw    float64
	ih    float64

	dragging  bool
	lastX     float32
	lastY     float32
	saving    atomic.Bool
	failed    atomic.Bool
	zoom      widget.Slider
	turn      widget.Slider
	left      widget.Button
	right     widget.Button
	reset     widget.Button
	cancel    widget.Button
	save      widget.Button
	stageSize float32
	laidOut   bool
}

// New makes the window for a picked picture.
func New(opt Options) *Editor {
	e := &Editor{opt: opt, kind: opt.Purpose.kind(), iw: float64(opt.Source.W), ih: float64(opt.Source.H)}
	e.key = fmt.Sprintf("imageedit-%d", pictureSerial.Add(1))
	e.zoom = widget.Slider{Min: 0, Max: zoomSteps, Step: 5, OnChange: func(v int) {
		e.zoomTo(float64(v) / zoomSteps)
	}}
	e.turn = widget.Slider{Min: -180, Max: 180, Step: 1, OnChange: func(v int) {
		e.set(imagecrop.RotateBy(e.place, float64(v)-e.place.Deg, e.iw, e.ih, e.mask))
	}}
	e.left = widget.Button{Icon: "arrow-counter-clockwise", Variant: widget.Ghost, Small: true, OnClick: func() { e.turnBy(-90) }}
	e.right = widget.Button{Icon: "arrow-clockwise", Variant: widget.Ghost, Small: true, OnClick: func() { e.turnBy(90) }}
	e.reset = widget.Button{Variant: widget.Ghost, Small: true, OnClick: func() { e.set(imagecrop.Start(e.iw, e.ih, e.mask)) }}
	e.cancel = widget.Button{Variant: widget.Ghost}
	e.save = widget.Button{Variant: widget.Primary}
	return e
}

func (e *Editor) layout(c *widget.Context, width float32) {
	banner := e.kind.Aspect > 1
	stageW := min(avatarStageW, max(stageMinW, width-stageSideGutter))
	share := float32(maskShareSquare)
	if banner {
		stageW = min(bannerStageW, max(stageMinW, width-stageSideGutter))
		share = maskShareBanner
	}
	maskW := float32(math.Round(float64(stageW * share)))
	maskH := float32(math.Round(float64(maskW) / e.kind.Aspect))
	stageH := maskH + (stageW - maskW)
	if banner {
		stageH = maskH + bannerExtra
	}
	e.stage = geom.Size{W: stageW, H: float32(math.Round(float64(stageH)))}
	e.mask = imagecrop.Mask{
		X: math.Round(float64(stageW-maskW) / 2), Y: math.Round(float64(e.stage.H-maskH) / 2),
		W: float64(maskW), H: float64(maskH), Circle: e.kind.Circle,
	}
	if !e.laidOut || e.stageSize != stageW {
		e.place = imagecrop.Start(e.iw, e.ih, e.mask)
		e.laidOut, e.stageSize = true, stageW
	}
}

func (e *Editor) set(p imagecrop.Placement) {
	e.place = imagecrop.Clamp(p, e.iw, e.ih, e.mask)
}

func (e *Editor) zoomTo(fraction float64) {
	s := imagecrop.ScaleAt(fraction, e.iw, e.ih, e.mask, e.place.Deg)
	e.set(imagecrop.ZoomAt(e.place, s/e.place.S, e.mask.X+e.mask.W/2, e.mask.Y+e.mask.H/2, e.iw, e.ih, e.mask))
}

func (e *Editor) turnBy(deg float64) { e.set(imagecrop.RotateBy(e.place, deg, e.iw, e.ih, e.mask)) }

func (e *Editor) close(c *widget.Context) { c.CloseModal() }

func (e *Editor) Draw(c *widget.Context, bounds geom.Rect) {
	c.Paint.Fill(bounds, 0, color.RGBA{A: backdropAlpha})
	titleKey, hintKey := e.opt.Purpose.words()
	width := min(cardMaxWidth, bounds.W*maxWidthShare)
	e.layout(c, width)

	title := widget.Label(c.T(titleKey), titleSize, paint.Semibold, widget.ToneText)
	hint := &widget.Text{Content: c.T(hintKey), Style: paint.TextStyle{Size: hintSize, Weight: paint.Regular}, Tone: widget.ToneMuted, Wrap: true, LineHeight: hintSize * 1.5}
	e.zoom.Value = int(math.Round(imagecrop.ZoomFraction(e.place, e.iw, e.ih, e.mask) * zoomSteps))
	e.turn.Value = int(math.Round(e.place.Deg))
	e.reset.Label = c.T("image_editor.reset")
	e.cancel.Label = c.T("image_editor.cancel")
	e.save.Label = c.T("image_editor.save")
	saving := e.saving.Load()
	if saving {
		e.save.Label = c.T("image_editor.saving")
	}
	e.cancel.Disabled, e.save.Disabled = saving, saving
	e.cancel.OnClick = func() { e.cancelled(c) }
	e.save.OnClick = func() { e.submit(c) }

	var note widget.Component = widget.Spacer{}
	if e.failed.Load() {
		note = &widget.Text{Content: c.T("app.that_picture_is_too_detailed"), Style: paint.TextStyle{Size: hintSize, Weight: paint.Regular}, Tone: widget.ToneDanger, Wrap: true}
	}
	body := widget.Col(cardGap,
		title, hint, stageBox{e},
		e.row(c, "image_editor.zoom", &e.zoom),
		e.row(c, "image_editor.rotate", &e.turn, &e.left, &e.right),
		note,
		&widget.Row{Gap: 8, Items: []widget.RowItem{widget.Fixed(&e.reset), widget.Grow(widget.Spacer{}), widget.Fixed(&e.cancel), widget.Fixed(&e.save)}},
	)
	edge := c.Hairline()
	inner := width - 2*(cardPadX+edge)
	height := min(body.Measure(c, inner).H+cardPadTop+cardPadBottom+2*edge, bounds.H-2*cardMargin)
	card := geom.Rect{X: bounds.X + (bounds.W-width)/2, Y: bounds.Y + (bounds.H-height)/2, W: width, H: height}
	if c.Clicked(bounds) && !c.Hovered(card) && !saving {
		c.Claim()
		e.cancelled(c)
		return
	}
	c.Layer(e)
	if c.EscapeFor(e) && !saving {
		e.cancelled(c)
		return
	}
	c.Paint.Fill(card, cardRadius, c.Theme.Surface)
	c.Paint.Stroke(card, cardRadius, edge, c.Theme.Border)
	body.Draw(c, geom.Rect{X: card.X + cardPadX + edge, Y: card.Y + cardPadTop + edge, W: inner, H: height - cardPadTop - cardPadBottom - 2*edge})
}

func (e *Editor) row(c *widget.Context, label string, items ...widget.Component) widget.Component {
	l := &widget.Text{Content: c.T(label), Style: paint.TextStyle{Size: labelSize, Weight: paint.Regular}, Tone: widget.ToneText, Opacity: labelAlpha}
	row := &widget.Row{Gap: 9.6, Items: []widget.RowItem{widget.Fixed(fixedWidth{W: labelWidth, Child: l}), widget.Grow(items[0])}}
	for _, it := range items[1:] {
		row.Items = append(row.Items, widget.Fixed(it))
	}
	return row
}

func (e *Editor) cancelled(c *widget.Context) {
	c.CloseModal()
	if e.opt.OnCancel != nil {
		e.opt.OnCancel()
	}
}

func (e *Editor) submit(c *widget.Context) {
	if !e.saving.CompareAndSwap(false, true) {
		return
	}
	e.failed.Store(false)
	src, place, mask, kind := e.opt.Source, e.place, e.mask, e.kind
	go func() {
		res, err := imagecrop.Encode(src, place, mask, kind)
		c.Post(func() {
			e.saving.Store(false)
			if err != nil {
				e.failed.Store(true)
				return
			}
			c.CloseModal()
			e.opt.OnDone(res)
		})
	}()
}

// stageBox is the picture behind its mask, which is what takes the hand.
type stageBox struct{ e *Editor }

func (s stageBox) Measure(*widget.Context, float32) geom.Size { return s.e.stage }

func (s stageBox) Draw(c *widget.Context, r geom.Rect) {
	e := s.e
	r = geom.Rect{X: r.X + (r.W-e.stage.W)/2, Y: r.Y, W: e.stage.W, H: e.stage.H}
	e.hand(c, r)
	c.Paint.Fill(r, stageRadius, color.RGBA{A: 255})
	c.Paint.PushClip(r)
	e.drawPicture(c, r)
	e.drawMask(c, r)
	c.Paint.PopClip()
	c.Paint.Corners(r, stageRadius, c.Theme.Surface)
}

func (e *Editor) hand(c *widget.Context, r geom.Rect) {
	hovered := c.Hovered(r)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	if hovered && c.In.Pressed {
		c.Claim()
		e.dragging, e.lastX, e.lastY = true, c.In.MouseX, c.In.MouseY
	}
	if e.dragging {
		c.SetCursor(rl.MouseCursorResizeAll)
		dx, dy := float64(c.In.MouseX-e.lastX), float64(c.In.MouseY-e.lastY)
		e.lastX, e.lastY = c.In.MouseX, c.In.MouseY
		if dx != 0 || dy != 0 {
			p := e.place
			p.CX, p.CY = p.CX+dx, p.CY+dy
			e.set(p)
		}
		if !c.In.Down {
			e.dragging = false
		}
	}
	if hovered && c.In.Wheel != 0 {
		e.set(imagecrop.ZoomAt(e.place, math.Exp(float64(c.In.Wheel)*wheelZoom), float64(c.In.MouseX-r.X), float64(c.In.MouseY-r.Y), e.iw, e.ih, e.mask))
	}
	step := float64(keyStep)
	if c.In.Shift {
		step = keyStepFast
	}
	p := e.place
	switch {
	case c.In.Left:
		p.CX -= step
	case c.In.Right:
		p.CX += step
	case c.In.KeyUp:
		p.CY -= step
	case c.In.KeyDown:
		p.CY += step
	}
	if p != e.place {
		e.set(p)
	}
	for _, ch := range c.In.Typed {
		switch ch {
		case '+', '=':
			e.set(imagecrop.ZoomAt(e.place, 1.1, e.mask.X+e.mask.W/2, e.mask.Y+e.mask.H/2, e.iw, e.ih, e.mask))
		case '-':
			e.set(imagecrop.ZoomAt(e.place, 1/1.1, e.mask.X+e.mask.W/2, e.mask.Y+e.mask.H/2, e.iw, e.ih, e.mask))
		}
	}
}

func (e *Editor) drawPicture(c *widget.Context, stage geom.Rect) {
	if e.pic == nil {
		data := e.opt.Data
		e.pic = c.Paint.Picture(e.key, func() ([]byte, error) { return data, nil })
	}
	p := e.place
	cos, sin := math.Cos(p.Deg*math.Pi/180), math.Sin(p.Deg*math.Pi/180)
	hw, hh := e.iw*p.S/2, e.ih*p.S/2
	var corners [4][2]float32
	for i, k := range [4][2]float64{{-1, -1}, {1, -1}, {1, 1}, {-1, 1}} {
		x, y := k[0]*hw, k[1]*hh
		corners[i] = [2]float32{stage.X + float32(p.CX+x*cos-y*sin), stage.Y + float32(p.CY+x*sin+y*cos)}
	}
	c.Paint.DrawQuad(e.pic, corners, color.RGBA{255, 255, 255, 255})
}

func (e *Editor) drawMask(c *widget.Context, stage geom.Rect) {
	m := geom.Rect{X: stage.X + float32(e.mask.X), Y: stage.Y + float32(e.mask.Y), W: float32(e.mask.W), H: float32(e.mask.H)}
	dim := color.RGBA{A: dimAlpha}
	c.Paint.Fill(geom.Rect{X: stage.X, Y: stage.Y, W: stage.W, H: m.Y - stage.Y}, 0, dim)
	c.Paint.Fill(geom.Rect{X: stage.X, Y: m.Bottom(), W: stage.W, H: stage.Bottom() - m.Bottom()}, 0, dim)
	c.Paint.Fill(geom.Rect{X: stage.X, Y: m.Y, W: m.X - stage.X, H: m.H}, 0, dim)
	c.Paint.Fill(geom.Rect{X: m.Right(), Y: m.Y, W: stage.Right() - m.Right(), H: m.H}, 0, dim)
	edge := theme.WithAlpha(color.RGBA{255, 255, 255, 255}, maskEdgeAlpha)
	if e.kind.Circle {
		c.Paint.Corners(m, m.W/2, dim)
		c.Paint.Stroke(m, m.W/2, maskEdge, edge)
		return
	}
	c.Paint.Stroke(m, 0, maskEdge, edge)
	if e.kind.Aspect > 1 && e.opt.Purpose == ProfileBanner {
		strip := geom.Rect{X: m.X, Y: m.Y + m.H/4, W: m.W, H: m.H / 2}
		c.Paint.DashedRoundRect(strip, 0, 1, 4, 3, theme.WithAlpha(color.RGBA{255, 255, 255, 255}, stripAlpha))
	}
}

// fixedWidth gives its child a set width.
type fixedWidth struct {
	W     float32
	Child widget.Component
}

func (f fixedWidth) Measure(c *widget.Context, _ float32) geom.Size {
	return geom.Size{W: f.W, H: f.Child.Measure(c, f.W).H}
}

func (f fixedWidth) Draw(c *widget.Context, r geom.Rect) { f.Child.Draw(c, r) }
