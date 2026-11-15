package channels

import (
	"image/color"
	"strconv"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"

	rl "github.com/gen2brain/raylib-go/raylib"
)

const (
	panelTopGap       = 8
	panelMargin       = 16
	panelWidth        = 430
	panelShare        = 0.48
	panelMinWidth     = 300
	resultsRadius     = 10
	panelShadowA      = 115
	panelHeadPadY     = 9.6
	panelHeadPadX     = 11.2
	panelHeadGap      = 6.4
	panelCountLine    = 22.8
	panelPagerPad     = 8
	panelPagerH       = 32
	panelDim          = 0.45
	menuMinWidth      = 160
	menuPad           = 4
	menuRadius        = 8
	menuItemPadY      = 6.4
	menuItemPadX      = 9.6
	menuItemLine      = 21.12
	menuItemRadius    = 5
	menuGapBelow      = 4
	menuShadowA       = 128
	emptyGap          = 4.8
	emptyBodyPad      = 16
	resultsEmptyAlpha = 0.75
)

var (
	panelCountStyle = paint.TextStyle{Size: 15.2, Weight: paint.Bold}
	menuItemStyle   = paint.TextStyle{Size: 14.08, Weight: paint.Regular}
	menuItemOn      = paint.TextStyle{Size: 14.08, Weight: paint.Semibold}
	emptyTitle      = paint.TextStyle{Size: 14, Weight: paint.Bold}
	emptyText       = paint.TextStyle{Size: 14, Weight: paint.Regular}
)

// resultsPanel is what a search found, laid over the member list for as long as it is wanted.
type resultsPanel struct {
	scroll   widget.Scroll
	column   cardColumn
	filters  widget.Button
	sort     widget.Button
	close    widget.Button
	pager    widget.Pager
	sortOpen bool
	built    int
	width    float32
	avail    float32
	zoom     float32
	wired    bool
	sortAt   geom.Rect
	c        *widget.Context
	model    model
	rect     geom.Rect
	paint    func()
}

func (s *Screen) drawResults(c *widget.Context, m model, head geom.Rect) {
	q := &s.chat.find.search
	if !q.open {
		return
	}
	p := &q.panel
	if !p.wired {
		p.wired = true
		p.filters = widget.Button{Icon: "sliders-horizontal", Variant: widget.Ghost, Small: true, OnClick: func() { s.openFilters(q.model) }}
		p.sort = widget.Button{Icon: "arrows-down-up", Variant: widget.Ghost, Small: true, OnClick: func() { p.sortOpen = !p.sortOpen }}
		p.close = widget.Button{Icon: "x", Variant: widget.Ghost, Small: true, OnClick: q.closeResults}
		p.pager.OnPage = func(page int) { s.runSearch(q.text, page, false) }
		p.scroll.Bar, p.scroll.Overlay = true, true
	}
	width := max(panelMinWidth, min(panelWidth, panelShare*(c.Viewport.W-widget.RailWidth)))
	top := head.Y + chatHeadH + panelTopGap
	panel := geom.Rect{X: c.Viewport.W - panelMargin - width, Y: top, W: width, H: max(0, c.Viewport.H-panelMargin-top)}
	c.Popup(panel)
	if c.In.Pressed && panel.Contains(c.In.MouseX, c.In.MouseY) {
		c.Claim()
	}
	p.c, p.model, p.rect = c, m, panel
	if p.paint == nil {
		p.paint = func() { s.paintResults(p.c, p.model, p.rect) }
	}
	c.Overlay(p.paint)
}

func (s *Screen) paintResults(c *widget.Context, m model, panel geom.Rect) {
	q := &s.chat.find.search
	p := &q.panel
	edge := c.Hairline()
	c.Paint.Shadow(panel, resultsRadius, sheetShadowY, sheetBlur, color.RGBA{A: panelShadowA})
	c.Paint.Fill(panel, resultsRadius, c.Theme.Surface)
	inner := panel.InsetAll(edge)
	c.Paint.PushClip(inner)

	headH := s.drawResultsHead(c, q, p, inner)
	body := geom.Rect{X: inner.X, Y: inner.Y + headH, W: inner.W, H: inner.H - headH}
	pages := q.pageCount()
	if pages > 1 {
		foot := geom.Rect{X: inner.X, Y: inner.Bottom() - (2*panelPagerPad + panelPagerH + edge), W: inner.W, H: 2*panelPagerPad + panelPagerH + edge}
		body.H -= foot.H
		c.Paint.Fill(geom.Rect{X: foot.X, Y: foot.Y, W: foot.W, H: edge}, 0, c.Theme.Border)
		p.pager.Pages, p.pager.At = pages, q.page
		p.pager.Prev, p.pager.Next = c.T("search.prev"), c.T("search.next")
		p.pager.Draw(c, geom.Rect{X: foot.X, Y: foot.Y + edge + panelPagerPad, W: foot.W, H: panelPagerH})
	}
	s.drawResultsBody(c, m, q, p, body)
	c.Paint.PopClip()
	c.Paint.Stroke(panel, resultsRadius, edge, c.Theme.Border)
	s.drawSortMenu(c, q, p)
}

func (s *Screen) drawResultsHead(c *widget.Context, q *searchState, p *resultsPanel, inner geom.Rect) float32 {
	edge := c.Hairline()
	p.filters.Label = c.T("search.filters")
	if len(q.chips) > 0 {
		p.filters.Label = c.T("search.filters_n", "count", strconv.Itoa(len(q.chips)))
	}
	p.sort.Label = c.T("search.sort")
	filters, sort, closer := p.filters.Measure(c, 0), p.sort.Measure(c, 0), p.close.Measure(c, 0)
	h := 2*panelHeadPadY + filters.H + edge
	mid := inner.Y + (h-edge)/2
	x := inner.Right() - panelHeadPadX - closer.W
	p.close.Draw(c, geom.Rect{X: x, Y: mid - closer.H/2, W: closer.W, H: closer.H})
	x -= panelHeadGap + sort.W
	p.sortAt = geom.Rect{X: x, Y: mid - sort.H/2, W: sort.W, H: sort.H}
	p.sort.Draw(c, p.sortAt)
	x -= panelHeadGap + filters.W
	p.filters.Draw(c, geom.Rect{X: x, Y: mid - filters.H/2, W: filters.W, H: filters.H})
	c.Paint.TextIn(geom.Rect{X: inner.X, Y: inner.Y, W: x - panelHeadGap - inner.X, H: h}, s.countText(c, q), inner.X+panelHeadPadX, mid-panelCountLine/2, panelCountLine, panelCountStyle, c.Theme.Text)
	c.Paint.Fill(geom.Rect{X: inner.X, Y: inner.Y + h - edge, W: inner.W, H: edge}, 0, c.Theme.Border)
	return h
}

func (s *Screen) countText(c *widget.Context, q *searchState) string {
	switch {
	case q.loading && len(q.results) == 0:
		return c.T("search.searching")
	case q.capped:
		return c.T("search.results_capped", "count", strconv.Itoa(q.total))
	}
	return c.Strings.Plural("search.results", q.total, "count", strconv.Itoa(q.total))
}

func (s *Screen) drawResultsBody(c *widget.Context, m model, q *searchState, p *resultsPanel, body geom.Rect) {
	if q.failure != "" || (!q.loading && len(q.results) == 0) {
		s.drawNoResults(c, q, body)
		return
	}
	full := body.W - 2*listPad
	if p.built != q.version || p.width != full || p.avail != body.H || p.zoom != c.Paint.Zoom {
		p.built, p.width, p.avail, p.zoom = q.version, full, body.H, c.Paint.Zoom
		p.column.layout(c, body.H, full, func(width float32) { s.buildResults(c, m, q, p, width) })
	}
	p.column.view = body
	p.scroll.Child = &p.column
	p.scroll.Draw(c, body)
	if q.loading {
		c.Paint.Fill(body, 0, theme.WithAlpha(c.Theme.Surface, panelDim))
	}
}

func (s *Screen) drawNoResults(c *widget.Context, q *searchState, body geom.Rect) {
	title, hint := c.T("search.no_results"), c.T("search.no_results_hint")
	if q.failure != "" {
		title, hint = q.failure, ""
	}
	h := float32(emptyLine)
	if hint != "" {
		h += emptyGap + emptyLine
	}
	y := body.Y + (body.H-h)/2
	ink := theme.WithAlpha(c.Theme.Text, resultsEmptyAlpha)
	if hint == "" {
		c.Paint.Text(title, body.X+(body.W-c.Paint.TextWidth(title, emptyText))/2, y, emptyLine, emptyText, ink)
		return
	}
	c.Paint.Text(title, body.X+(body.W-c.Paint.TextWidth(title, emptyTitle))/2, y, emptyLine, emptyTitle, ink)
	c.Paint.Text(hint, body.X+(body.W-c.Paint.TextWidth(hint, emptyText))/2, y+emptyLine+emptyGap, emptyLine, emptyText, ink)
}

// buildResults lays the results out as cards under a heading for each channel, in the order the channels first appear.
func (s *Screen) buildResults(c *widget.Context, m model, q *searchState, p *resultsPanel, width float32) {
	p.column.screen = s
	p.column.items = p.column.items[:0]
	var order []int
	groups := map[int][]*msgCard{}
	for _, msg := range q.results {
		card := s.newCard(c, m, msg, "", width, true)
		id, channel, thread := msg.ID, msg.ChannelID, msg.Thread()
		card.current = id == s.chat.find.currentHit
		card.jump = func() {
			s.chat.find.currentHit = id
			for i := range p.column.items {
				if k := p.column.items[i].card; k != nil {
					k.current = k.msg.ID == id
				}
			}
			s.goToThread(channel, id, thread)
		}
		if _, seen := groups[channel]; !seen {
			order = append(order, channel)
		}
		groups[channel] = append(groups[channel], card)
	}
	for _, channel := range order {
		name := s.channelNamed(m, channel)
		if name == "" {
			name = strconv.Itoa(channel)
		}
		p.column.items = append(p.column.items, colItem{heading: name})
		for _, card := range groups[channel] {
			p.column.items = append(p.column.items, colItem{card: card})
		}
	}
}

func (s *Screen) drawSortMenu(c *widget.Context, q *searchState, p *resultsPanel) {
	if !p.sortOpen {
		return
	}
	edge := c.Hairline()
	newest, oldest := c.T("search.sort_new"), c.T("search.sort_old")
	w := max(menuMinWidth, max(c.Paint.TextWidth(newest, menuItemOn), c.Paint.TextWidth(oldest, menuItemOn))+2*(menuItemPadX+menuPad+edge))
	rowH := float32(menuItemPadY*2 + menuItemLine)
	menu := geom.Rect{X: p.sortAt.Right() - w, Y: p.sortAt.Bottom() + menuGapBelow, W: w, H: 2*(menuPad+edge) + 2*rowH}
	if c.In.Pressed && !menu.Contains(c.In.MouseX, c.In.MouseY) && !p.sortAt.Contains(c.In.MouseX, c.In.MouseY) {
		p.sortOpen = false
		return
	}
	c.Popup(menu)
	c.Paint.Shadow(menu, menuRadius, 8, 24, color.RGBA{A: menuShadowA})
	c.Paint.Fill(menu, menuRadius, c.Theme.Surface2)
	c.Paint.Stroke(menu, menuRadius, edge, c.Theme.Border)
	for i, label := range [...]string{newest, oldest} {
		row := geom.Rect{X: menu.X + menuPad + edge, Y: menu.Y + menuPad + edge + float32(i)*rowH, W: menu.W - 2*(menuPad+edge), H: rowH}
		on := q.oldest == (i == 1)
		style, ink := menuItemStyle, c.Theme.Text
		if on {
			style, ink = menuItemOn, c.Theme.Accent
		}
		if c.Hovered(row) {
			c.SetCursor(rl.MouseCursorPointingHand)
			c.Paint.Fill(row, menuItemRadius, theme.WithAlpha(c.Theme.Tint, 0.1))
			if c.In.Pressed {
				c.Claim()
				q.oldest, p.sortOpen = i == 1, false
				s.runSearch(q.text, 0, false)
			}
		}
		c.Paint.Text(label, row.X+menuItemPadX, row.Y+menuItemPadY, menuItemLine, style, ink)
	}
}
