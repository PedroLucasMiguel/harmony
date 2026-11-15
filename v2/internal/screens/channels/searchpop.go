package channels

import (
	"image/color"
	"strings"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/store"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	popWidth        = 440
	popMargin       = 8
	popBelow        = 5.2
	popPad          = 4.8
	popRadius       = 10
	popMaxHeight    = 540
	popMaxShare     = 0.7
	popShadowA      = 140
	popHeadingTop   = 8
	popHeadingBot   = 4
	popHeadingLine  = 18.72
	popRowPadY      = 7.2
	popRowPadX      = 9.6
	popRowGap       = 11.2
	popRowRadius    = 6
	popRowHover     = 0.09
	popIcon         = 22.1
	popIconGlyph    = 20
	popIconAlpha    = 0.65
	popTitleLine    = 22.08
	popHintLine     = 18.72
	popAvatar       = 24
	popAvatarFont   = 10.8
	popEmptyPadY    = 11.2
	popEmptyPadX    = 12.8
	popEmptyLine    = 20.4
	popActionSize   = 27.2
	popActionGlyph  = 14
	popChipGap      = 4.8
	popHeadingAlpha = 0.8
	popHintAlpha    = 0.65
)

var (
	popHeadingStyle = paint.TextStyle{Size: 12.48, Weight: paint.Bold}
	popTitleStyle   = paint.TextStyle{Size: 14.72, Weight: paint.Regular}
	popHintStyle    = paint.TextStyle{Size: 12.48, Weight: paint.Regular}
	popHintBold     = paint.TextStyle{Size: 12.48, Weight: paint.Bold}
	popTextStyle    = paint.TextStyle{Size: 13.6, Weight: paint.Regular}
)

// popRow is one line the search box offers: a filter to start, a value for one, or a search made before.
type popRow struct {
	icon    string
	face    string
	title   string
	hintKey string
	hint    string
	lines   bool
	chips   []store.SearchChip
	text    string
	pre     bool
	choose  func()
}

type popItem struct {
	heading string
	action  bool
	row     popRow
}

// searchPop is the list that hangs from the search box: the filters and past searches when it is empty, what a filter can be while one is typed.
type searchPop struct {
	open   bool
	dirty  bool
	empty  bool
	items  []popItem
	active int
	scroll widget.Scroll

	c      *widget.Context
	s      *Screen
	box    geom.Rect
	paint  func()
	view   geom.Rect
	inside bool
}

func (p *searchPop) close() {
	p.open, p.active = false, -1
	p.items = p.items[:0]
}

func (p *searchPop) selectable() int {
	n := 0
	for _, it := range p.items {
		if it.heading == "" {
			n++
		}
	}
	return n
}

func (p *searchPop) rowAt(index int) *popRow {
	n := 0
	for i := range p.items {
		if p.items[i].heading != "" {
			continue
		}
		if n == index {
			return &p.items[i].row
		}
		n++
	}
	return nil
}

// step moves the highlight with the arrow keys.
func (p *searchPop) step(by int) {
	n := p.selectable()
	if n == 0 {
		return
	}
	p.active = (p.active + by + n) % n
}

func (p *searchPop) itemHeight(it popItem) float32 {
	switch {
	case it.heading != "":
		return popHeadingTop + popHeadingLine + popHeadingBot
	case it.row.lines:
		return 2*popRowPadY + popTitleLine + popHintLine
	case it.row.face != "":
		return 2*popRowPadY + popAvatar
	}
	return 2*popRowPadY + popIcon*1.25
}

func (p *searchPop) height() float32 {
	if p.empty {
		return 2*popEmptyPadY + popEmptyLine
	}
	h := float32(0)
	for _, it := range p.items {
		h += p.itemHeight(it)
	}
	return h
}

func (p *searchPop) Measure(c *widget.Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: p.height()}
}

// show hangs the list under the box, over everything, while it is open.
func (p *searchPop) show(c *widget.Context, s *Screen, box geom.Rect) {
	if !p.open {
		return
	}
	p.c, p.s, p.box = c, s, box
	if p.paint == nil {
		p.paint = p.draw
		p.scroll.Bar, p.scroll.Overlay, p.scroll.Child = true, true, p
	}
	c.Overlay(p.paint)
}

func (p *searchPop) draw() {
	c := p.c
	edge := c.Hairline()
	width := min(popWidth, c.Viewport.W-2*popMargin)
	card := geom.Rect{X: p.box.X + edge, Y: p.box.Bottom() + popBelow, W: width}
	card.H = min(2*(popPad+edge)+p.height(), min(popMaxHeight, popMaxShare*c.Viewport.H))
	c.Popup(card)
	if c.In.Pressed && !card.Contains(c.In.MouseX, c.In.MouseY) && !p.box.Contains(c.In.MouseX, c.In.MouseY) {
		p.close()
		return
	}
	if card.Contains(c.In.MouseX, c.In.MouseY) && c.In.Pressed {
		c.Claim()
	}
	c.Paint.Shadow(card, popRadius, sheetShadowY, sheetBlur, color.RGBA{A: popShadowA})
	c.Paint.Fill(card, popRadius, c.Theme.Surface)
	c.Paint.Stroke(card, popRadius, edge, c.Theme.Border)
	p.view = card.InsetAll(edge + popPad)
	c.Paint.PushClip(p.view)
	p.scroll.Draw(c, p.view)
	c.Paint.PopClip()
}

func (p *searchPop) Draw(c *widget.Context, r geom.Rect) {
	if p.empty {
		c.Paint.Text(c.T("search.nothing_to_offer"), r.X+popEmptyPadX, r.Y+popEmptyPadY, popEmptyLine, popTextStyle, theme.WithAlpha(c.Theme.Text, 0.65))
		return
	}
	y := r.Y
	index := 0
	for i := range p.items {
		it := &p.items[i]
		h := p.itemHeight(*it)
		area := geom.Rect{X: r.X, Y: y, W: r.W, H: h}
		y += h
		if area.Bottom() < p.view.Y || area.Y > p.view.Bottom() {
			if it.heading == "" {
				index++
			}
			continue
		}
		if it.heading != "" {
			p.drawHeading(c, area, it)
			continue
		}
		p.drawRow(c, area, &it.row, index)
		index++
	}
}

func (p *searchPop) drawHeading(c *widget.Context, r geom.Rect, it *popItem) {
	c.Paint.Text(it.heading, r.X+popRowPadX, r.Y+popHeadingTop, popHeadingLine, popHeadingStyle, theme.WithAlpha(c.Theme.Text, popHeadingAlpha))
	if !it.action {
		return
	}
	btn := geom.Rect{X: r.Right() - popActionSize - 2, Y: r.Y + (r.H-popActionSize)/2, W: popActionSize, H: popActionSize}
	alpha := float32(popIconAlpha)
	if shown := btn.Intersect(p.view); c.Hovered(shown) {
		alpha = 1
		c.SetCursor(rl.MouseCursorPointingHand)
		c.Paint.Fill(btn, popRowRadius, theme.WithAlpha(c.Theme.Tint, 0.1))
		if c.In.Pressed {
			c.Claim()
			p.s.forgetSearches()
		}
	}
	c.Paint.Icon("trash", geom.Rect{X: btn.X + (btn.W-popActionGlyph)/2, Y: btn.Y + (btn.H-popActionGlyph)/2, W: popActionGlyph, H: popActionGlyph}, theme.WithAlpha(c.Theme.Text, alpha))
}

func (p *searchPop) drawRow(c *widget.Context, r geom.Rect, row *popRow, index int) {
	visible := r.Intersect(p.view)
	hovered := visible.W > 0 && visible.H > 0 && c.Hovered(visible)
	if hovered && c.In.Moved {
		p.active = index
	}
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.In.Pressed {
			c.Claim()
			row.choose()
			return
		}
	}
	if p.active == index {
		c.Paint.Fill(r, popRowRadius, theme.WithAlpha(c.Theme.Tint, popRowHover))
	}
	x := r.X + popRowPadX
	mid := r.Y + r.H/2
	switch {
	case row.face != "":
		widget.Avatar{Name: row.face, Size: popAvatar, Font: popAvatarFont}.Draw(c, geom.Rect{X: x, Y: mid - popAvatar/2, W: popAvatar, H: popAvatar})
		x += popAvatar + popRowGap
	case row.icon != "":
		g := popIconGlyph
		c.Paint.Icon(row.icon, geom.Rect{X: x + (popIcon-float32(g))/2, Y: mid - float32(g)/2, W: float32(g), H: float32(g)}, theme.WithAlpha(c.Theme.Text, popIconAlpha))
		x += popIcon + popRowGap
	}
	switch {
	case row.chips != nil || row.text != "" && row.title == "":
		p.drawHistory(c, geom.Rect{X: x, Y: r.Y, W: r.Right() - popRowPadX - x, H: r.H}, row)
	case row.lines:
		top := r.Y + popRowPadY
		c.Paint.Text(row.title, x, top, popTitleLine, popTitleStyle, c.Theme.Text)
		p.drawHint(c, x, top+popTitleLine, row)
	default:
		c.Paint.Text(row.title, x, mid-popTitleLine/2, popTitleLine, popTitleStyle, c.Theme.Text)
		if row.hint != "" {
			x += c.Paint.TextWidth(row.title, popTitleStyle) + popRowGap
			c.Paint.Text(row.hint, x, mid-popHintLine/2, popHintLine, popHintStyle, theme.WithAlpha(c.Theme.Text, popHintAlpha))
		}
	}
}

func (p *searchPop) drawHint(c *widget.Context, x, y float32, row *popRow) {
	ink := theme.WithAlpha(c.Theme.Text, popHintAlpha)
	if row.hintKey != "" {
		c.Paint.Text(row.hintKey, x, y, popHintLine, popHintBold, ink)
		x += c.Paint.TextWidth(row.hintKey, popHintBold)
	}
	c.Paint.Text(row.hint, x, y, popHintLine, popHintStyle, ink)
}

func (p *searchPop) drawHistory(c *widget.Context, r geom.Rect, row *popRow) {
	x := r.X
	for _, chip := range row.chips {
		fc := widget.FilterChip{Key: chip.Key + ":", Value: chip.Label, Static: true}
		size := fc.Measure(c)
		fc.Show(c, geom.Rect{X: x, Y: r.Y + (r.H-size.H)/2, W: size.W, H: size.H})
		x += size.W + popChipGap
	}
	if row.text != "" {
		c.Paint.TextIn(geom.Rect{X: x, Y: r.Y, W: max(0, r.Right()-x), H: r.H}, row.text, x, r.Y+(r.H-popTextLine)/2, popTextLine, popTextStyle, c.Theme.Text)
	}
}

const popTextLine = 20.4

// refresh builds what the list offers for what is typed: the filters and the searches made before when the box is empty, the values of a filter while one is typed.
func (s *Screen) refreshPop(m model) {
	q := &s.chat.find.search
	p := &q.pop
	p.dirty = false
	p.empty = false
	p.items = p.items[:0]
	text := q.field.Value
	switch found := trailingToken.FindStringSubmatch(text); {
	case found != nil:
		s.valueItems(m, strings.ToLower(found[1]), found[2])
		p.empty = len(p.items) == 0
		p.open = true
	case strings.TrimSpace(text) == "":
		s.filterItems()
		s.historyItems()
		p.open = true
	default:
		p.close()
		return
	}
	p.active = -1
	if first := p.rowAt(0); first != nil && first.pre {
		p.active = 0
	}
}

func (s *Screen) filterItems() {
	c := s.chat.find.c
	q := &s.chat.find.search
	p := &q.pop
	p.items = append(p.items, popItem{heading: c.T("search.filters")})
	add := func(icon, title, key, hint string) {
		p.items = append(p.items, popItem{row: popRow{icon: icon, title: title, lines: true, hintKey: key, hint: hint, choose: func() { s.startFilter(strings.TrimSuffix(key, ":")) }}})
	}
	add("user", c.T("search.from"), "from:", " user")
	add("hash", c.T("search.in"), "in:", " channel")
	add("paperclip", c.T("search.has"), "has:", " link, embed or file")
	add("at", c.T("search.mentions"), "mentions:", " user")
	p.items = append(p.items, popItem{row: popRow{icon: "sliders-horizontal", title: c.T("search.more"), lines: true, hint: c.T("search.more_hint"), choose: func() {
		p.close()
		s.openFilters(s.chat.find.search.model)
	}}})
}

func (s *Screen) historyItems() {
	c := s.chat.find.c
	q := &s.chat.find.search
	list := s.Settings.SearchHistory[store.ServerKey(s.Server.URL)]
	if len(list) == 0 {
		return
	}
	q.pop.items = append(q.pop.items, popItem{heading: c.T("search.history"), action: true})
	for _, entry := range list {
		q.pop.items = append(q.pop.items, popItem{row: popRow{icon: "magnifying-glass", chips: entry.Chips, text: entry.Text, choose: func() { s.replay(entry) }}})
	}
}

func (s *Screen) replay(entry store.SearchEntry) {
	q := &s.chat.find.search
	q.chips = q.chips[:0]
	for _, c := range entry.Chips {
		q.chips = append(q.chips, chipFromStore(c))
	}
	q.field.SetValue(entry.Text)
	q.pop.close()
	s.runSearch(entry.Text, 0, true)
}

func chipFromStore(c store.SearchChip) filter {
	f := filter{key: c.Key, label: c.Label}
	switch v := c.Value.(type) {
	case float64:
		f.id = int(v)
	case string:
		f.word = v
	case bool:
		f.word = "false"
		if v {
			f.word = "true"
		}
	}
	return f
}

func (s *Screen) forgetSearches() {
	s.Settings.ForgetSearches(store.ServerKey(s.Server.URL))
	s.Settings.Save()
	s.chat.find.search.pop.dirty = true
}

// startFilter puts "key:" in the box, after the words already there, and offers what it can be.
func (s *Screen) startFilter(key string) {
	q := &s.chat.find.search
	before := strings.TrimRight(trailingToken.ReplaceAllString(q.field.Value, ""), " ")
	if before != "" {
		before += " "
	}
	q.field.SetValue(before + key + ":")
	q.field.RequestFocus()
	q.pop.dirty = true
}
