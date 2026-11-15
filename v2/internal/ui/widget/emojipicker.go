package widget

import (
	"image/color"
	"strings"
	"sync"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/emoji"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	pickerWidth      = 380
	pickerMaxHeight  = 420
	pickerPad        = 9.6
	pickerGap        = 8
	pickerRadius     = 10
	pickerMargin     = 8
	pickerHeadRow    = 26
	pickerHeadSize   = 10.88
	pickerHeadTop    = 6.4
	pickerHeadLeft   = 3.2
	pickerCellMin    = 34
	pickerCellRadius = 6
	pickerGlyph      = 20.8
	pickerPicture    = 22.4
	pickerPreviewH   = 28.8
	pickerPreviewTop = 6.4
	pickerNameSize   = 12.8
	pickerEmptyPadY  = 8
	pickerEmptyPadX  = 3.2
	pickerEmptySize  = 13.6
	pickerRemoveSize = 16
	pickerRemoveOff  = 2
	pickerResultCap  = 300
	pickerRecentCap  = 24
	pickerShadowA    = 140
	pickerHoverAlpha = 0.2
)

var (
	pickerHeadStyle  = paint.TextStyle{Size: pickerHeadSize, Weight: paint.Bold, Spacing: pickerHeadSize * 0.06}
	pickerGlyphStyle = paint.TextStyle{Size: pickerGlyph, Weight: paint.Regular}
	pickerBigStyle   = paint.TextStyle{Size: pickerPicture, Weight: paint.Regular}
	pickerNameStyle  = paint.TextStyle{Size: pickerNameSize, Weight: paint.Regular}
	pickerEmptyStyle = paint.TextStyle{Size: pickerEmptySize, Weight: paint.Regular}
)

// PickerEmoji is one of the server's own emoji, as the picker offers it.
type PickerEmoji struct {
	ID        int
	Name      string
	Key       string
	Fetch     func() ([]byte, error)
	Removable bool
}

type pickItem struct {
	value  string
	name   string
	custom *PickerEmoji
}

type pickSection struct {
	head  string
	items []pickItem
}

type pickRow struct {
	top, height float32
	section     int
	from, to    int
}

func (r pickRow) isHead() bool { return r.from == r.to }

var standard struct {
	once     sync.Once
	sections []pickSection
}

func standardSections() []pickSection {
	standard.once.Do(func() {
		for _, s := range emoji.Sections() {
			sec := pickSection{head: strings.ToUpper(s.Label), items: make([]pickItem, len(s.Items))}
			for i, it := range s.Items {
				sec.items[i] = pickItem{value: it.Char, name: it.Name}
			}
			standard.sections = append(standard.sections, sec)
		}
	})
	return standard.sections
}

// EmojiPicker is the popover that offers every emoji: the server's own, the ones used lately, then the standard ones by
// section, with a search box. Only the rows in view are drawn. The tables it needs are built on another goroutine
// (Warm), so that opening it never waits for them.
type EmojiPicker struct {
	// OnAdd and OnRemove are the buttons for the server's own emoji; either may be nil.
	OnAdd    func()
	OnRemove func(id int)

	open      bool
	fresh     bool
	anchor    geom.Rect
	onPick    func(value string)
	custom    []PickerEmoji
	recent    []string
	search    TextField
	add       Button
	query     string
	typed     string
	dirty     bool
	sections  []pickSection
	owned     []pickItem
	results   []emoji.Item
	rows      []pickRow
	rowsWidth float32
	cols      int
	cell      float32
	colW      float32
	total     float32
	scroll    Scroll
	hovered   *pickItem
	box       geom.Rect
	ctx       *Context
	paint     func()
	building  bool
}

// Warm builds the standard emoji tables off the interface's thread.
func (p *EmojiPicker) Warm() {
	go func() {
		emoji.Warm()
		standardSections()
	}()
}

func (p *EmojiPicker) IsOpen() bool { return p.open }

// SetCustom replaces the server's emoji the picker offers.
func (p *EmojiPicker) SetCustom(list []PickerEmoji) {
	p.custom, p.dirty = list, true
}

// SetRecent replaces the emoji used last, newest first: characters, or :name: for the server's own.
func (p *EmojiPicker) SetRecent(list []string) {
	p.recent, p.dirty = list, true
}

// Open shows the picker over anchor; onPick gets the character, or :name: for one of the server's own, of what is chosen.
func (p *EmojiPicker) Open(anchor geom.Rect, onPick func(value string)) {
	p.open, p.fresh, p.anchor, p.onPick = true, true, anchor, onPick
	p.search.Value, p.typed, p.query, p.hovered, p.dirty = "", "", "", nil, true
	p.search.Search = true
	p.search.RequestFocus()
	p.scroll.offset = 0
}

func (p *EmojiPicker) Close() { p.open = false }

func (p *EmojiPicker) Toggle(anchor geom.Rect, onPick func(value string)) {
	if p.open {
		p.Close()
		return
	}
	p.Open(anchor, onPick)
}

// Show draws the picker over everything while it is open.
func (p *EmojiPicker) Show(c *Context) {
	if !p.open {
		return
	}
	p.ctx = c
	if p.paint == nil {
		p.paint = func() { p.draw(p.ctx) }
	}
	c.Overlay(p.paint)
}

func (p *EmojiPicker) draw(c *Context) {
	edge := c.Hairline()
	frame := pickerPad + edge
	searchH := p.search.Measure(c, 100).H
	height := min(pickerMaxHeight, c.Viewport.H-96)
	box := geom.Rect{W: min(pickerWidth, c.Viewport.W-32), H: height}
	box.X = max(pickerMargin, min(p.anchor.X-box.W/2, c.Viewport.W-box.W-pickerMargin))
	box.Y = p.anchor.Y - box.H - pickerMargin
	if box.Y < pickerMargin {
		box.Y = min(p.anchor.Bottom()+pickerMargin, c.Viewport.H-box.H-pickerMargin)
	}
	p.box = box
	c.Popup(box)
	c.Layer(p)

	inside := box.Contains(c.In.MouseX, c.In.MouseY)
	if !p.fresh && (c.EscapeFor(p) || c.In.Pressed && !inside && !p.anchor.Contains(c.In.MouseX, c.In.MouseY)) {
		p.open = false
		return
	}
	p.fresh = false
	if inside && c.In.Pressed {
		c.Claim()
	}

	c.Paint.Shadow(box, pickerRadius, 12, 32, color.RGBA{A: pickerShadowA})
	c.Paint.Fill(box, pickerRadius, c.Theme.Surface)
	c.Paint.Stroke(box, pickerRadius, edge, c.Theme.Border)
	content := box.InsetAll(frame)

	p.drawHead(c, geom.Rect{X: content.X, Y: content.Y, W: content.W, H: searchH})
	p.refresh(c)

	empty := float32(0)
	if len(p.sections) == 0 && p.query != "" && p.ready() {
		empty = 2*pickerEmptyPadY + pickerEmptySize*1.5
	}
	gridTop := content.Y + searchH + pickerGap
	previewTop := content.Bottom() - pickerPreviewH
	grid := geom.Rect{X: content.X, Y: gridTop, W: content.W, H: max(0, previewTop-pickerGap-empty-gridTop)}
	p.drawGrid(c, grid)
	if empty > 0 {
		text := c.T("app.nothing_called", "value", p.search.Value)
		c.Paint.Text(text, content.X+pickerEmptyPadX, grid.Bottom()+pickerGap+pickerEmptyPadY, pickerEmptySize*1.5, pickerEmptyStyle, c.Theme.Muted)
	}
	p.drawPreview(c, geom.Rect{X: content.X, Y: previewTop, W: content.W, H: pickerPreviewH})
}

func (p *EmojiPicker) drawHead(c *Context, r geom.Rect) {
	p.add.Label, p.add.Variant, p.add.Small = c.T("emoji_add.add"), Ghost, true
	p.add.OnClick = p.OnAdd
	addSize := p.add.Measure(c, 0)
	p.search.Placeholder = c.T("emoji_pop.search_emoji")
	field := geom.Rect{X: r.X, Y: r.Y, W: r.W, H: r.H}
	if p.OnAdd != nil {
		field.W = r.W - addSize.W - 6.4
		p.add.Draw(c, geom.Rect{X: r.Right() - addSize.W, Y: r.Y + (r.H-addSize.H)/2, W: addSize.W, H: addSize.H})
	}
	p.search.Draw(c, field)
}

func (p *EmojiPicker) ready() bool { return emoji.Ready() && len(standard.sections) > 0 }

// refresh rebuilds what the grid shows when the search, the recents or the server's emoji have changed.
func (p *EmojiPicker) refresh(c *Context) {
	if !p.ready() {
		if !p.building {
			p.building = true
			go func() {
				emoji.Warm()
				standardSections()
				c.Post(func() { p.building, p.dirty = false, true })
			}()
		}
		p.sections, p.rows, p.total = p.sections[:0], p.rows[:0], 0
		return
	}
	if p.search.Value != p.typed {
		p.typed, p.query, p.dirty = p.search.Value, emoji.Query(p.search.Value), true
		p.scroll.offset = 0
	}
	if !p.dirty {
		return
	}
	p.dirty = false
	p.rowsWidth = 0
	p.sections = p.sections[:0]
	p.owned = p.owned[:0]
	if p.query != "" {
		p.results = emoji.Search(p.query, pickerResultCap, p.results[:0])
		for i := range p.custom {
			if strings.Contains(p.custom[i].Name, p.query) {
				p.owned = append(p.owned, pickItem{value: ":" + p.custom[i].Name + ":", name: p.custom[i].Name, custom: &p.custom[i]})
			}
		}
		for _, it := range p.results {
			p.owned = append(p.owned, pickItem{value: it.Char, name: it.Name})
		}
		if len(p.owned) > 0 {
			p.sections = append(p.sections, pickSection{head: strings.ToUpper(c.T("app.matching", "value", p.search.Value)), items: p.owned})
		}
		return
	}
	if len(p.custom) > 0 {
		items := make([]pickItem, len(p.custom))
		for i := range p.custom {
			items[i] = pickItem{value: ":" + p.custom[i].Name + ":", name: p.custom[i].Name, custom: &p.custom[i]}
		}
		p.sections = append(p.sections, pickSection{head: strings.ToUpper(c.T("app.this_server")), items: items})
	}
	if len(p.recent) > 0 {
		items := make([]pickItem, 0, min(len(p.recent), pickerRecentCap))
		for _, v := range p.recent[:min(len(p.recent), pickerRecentCap)] {
			items = append(items, p.recentItem(v))
		}
		p.sections = append(p.sections, pickSection{head: strings.ToUpper(c.T("app.recent")), items: items})
	}
	p.sections = append(p.sections, standardSections()...)
}

func (p *EmojiPicker) recentItem(value string) pickItem {
	if len(value) > 2 && value[0] == ':' && value[len(value)-1] == ':' {
		name := value[1 : len(value)-1]
		for i := range p.custom {
			if p.custom[i].Name == name {
				return pickItem{value: value, name: name, custom: &p.custom[i]}
			}
		}
		return pickItem{value: value, name: name}
	}
	return pickItem{value: value, name: emoji.NameOf(value)}
}

// layoutRows lays the sections out as rows of cells for a width.
func (p *EmojiPicker) layoutRows(width float32) {
	p.rowsWidth = width
	p.cols = max(1, int(width/pickerCellMin))
	p.colW = width / float32(p.cols)
	p.cell = float32(int(p.colW))
	p.rows = p.rows[:0]
	top := float32(0)
	for i, s := range p.sections {
		p.rows = append(p.rows, pickRow{top: top, height: pickerHeadRow, section: i})
		top += pickerHeadRow
		for from := 0; from < len(s.items); from += p.cols {
			p.rows = append(p.rows, pickRow{top: top, height: p.cell, section: i, from: from, to: min(from+p.cols, len(s.items))})
			top += p.cell
		}
	}
	p.total = top
}

func (p *EmojiPicker) rowAt(y float32) int {
	lo, hi := 0, len(p.rows)-1
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if p.rows[mid].top <= y {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	return lo
}

func (p *EmojiPicker) drawGrid(c *Context, r geom.Rect) {
	width := r.W - scrollbarWidth
	if width != p.rowsWidth && len(p.sections) > 0 {
		p.layoutRows(width)
	}
	if len(p.sections) == 0 {
		p.rows, p.total = p.rows[:0], 0
		return
	}
	if c.Hovered(r) {
		p.scroll.offset -= c.In.Wheel * scrollStep
	}
	if p.total > r.H {
		p.scroll.dragThumb(c, r, p.total)
	}
	p.scroll.offset = min(max(p.scroll.offset, 0), max(0, p.total-r.H))
	offset := p.scroll.offset

	c.Paint.PushClip(r)
	for i := p.rowAt(offset); i < len(p.rows); i++ {
		row := p.rows[i]
		if row.top > offset+r.H {
			break
		}
		y := r.Y + row.top - offset
		if row.isHead() {
			c.Paint.Text(p.sections[row.section].head, r.X+pickerHeadLeft, y+pickerHeadTop, pickerHeadSize*1.5, pickerHeadStyle, c.Theme.Muted)
			continue
		}
		items := p.sections[row.section].items[row.from:row.to]
		for j := range items {
			p.drawCell(c, &items[j], geom.Rect{X: r.X + float32(j)*p.colW, Y: y, W: p.colW, H: row.height}, r)
		}
	}
	top := p.rows[p.rowAt(offset)]
	c.Paint.Fill(geom.Rect{X: r.X, Y: r.Y, W: width, H: pickerHeadRow}, 0, c.Theme.Surface)
	c.Paint.Text(p.sections[top.section].head, r.X+pickerHeadLeft, r.Y+pickerHeadTop, pickerHeadSize*1.5, pickerHeadStyle, c.Theme.Muted)
	c.Paint.PopClip()
	if p.total > r.H {
		p.scroll.drawThumb(c, r, p.total)
	}
}

func (p *EmojiPicker) drawCell(c *Context, it *pickItem, cell, grid geom.Rect) {
	visible := cell.Intersect(grid)
	over := visible.H > 0 && c.Hovered(visible)
	if over {
		p.hovered = it
		c.SetCursor(rl.MouseCursorPointingHand)
		c.Paint.Fill(cell, pickerCellRadius, theme.WithAlpha(c.Theme.Accent, pickerHoverAlpha))
	}
	if it.custom != nil && it.custom.Key != "" {
		drawPicked(c, it.custom, geom.Rect{X: cell.X + (cell.W-pickerPicture)/2, Y: cell.Y + (cell.H-pickerPicture)/2, W: pickerPicture, H: pickerPicture})
	} else {
		line := float32(pickerGlyph * 1.5)
		w := c.Paint.TextWidth(it.value, pickerGlyphStyle)
		c.Paint.Text(it.value, cell.X+(cell.W-w)/2, cell.Y+(cell.H-line)/2, line, pickerGlyphStyle, c.Theme.Text)
	}
	if over && it.custom != nil && it.custom.Removable && p.OnRemove != nil {
		x := geom.Rect{X: cell.Right() - pickerRemoveSize + pickerRemoveOff, Y: cell.Y - pickerRemoveOff, W: pickerRemoveSize, H: pickerRemoveSize}
		xover := c.Hovered(x)
		c.Paint.Circle(x.X+x.W/2, x.Y+x.H/2, x.W/2, c.Theme.Danger)
		c.Paint.Line(x.X+5, x.Y+5, x.Right()-5, x.Bottom()-5, 1.4, rl.White)
		c.Paint.Line(x.X+5, x.Bottom()-5, x.Right()-5, x.Y+5, 1.4, rl.White)
		if xover && c.Clicked(x) {
			c.Claim()
			p.OnRemove(it.custom.ID)
			return
		}
	}
	if over && c.Clicked(visible) {
		c.Claim()
		if p.onPick != nil {
			p.onPick(it.value)
		}
	}
}

func drawPicked(c *Context, e *PickerEmoji, r geom.Rect) {
	pic := c.Paint.Picture(e.Key, e.Fetch)
	w, h, ok := pic.Size()
	if !ok {
		return
	}
	if w > h {
		r.Y, r.H = r.Y+r.H*(1-float32(h)/float32(w))/2, r.H*float32(h)/float32(w)
	} else if h > w {
		r.X, r.W = r.X+r.W*(1-float32(w)/float32(h))/2, r.W*float32(w)/float32(h)
	}
	c.Paint.DrawPicture(pic, r, 0, false, color.RGBA{})
}

func (p *EmojiPicker) drawPreview(c *Context, r geom.Rect) {
	c.Paint.Fill(geom.Rect{X: r.X, Y: r.Y, W: r.W, H: c.Hairline()}, 0, c.Theme.Border)
	it := p.hovered
	if it == nil {
		return
	}
	mid := r.Y + pickerPreviewTop/2 + r.H/2
	x := r.X
	if it.custom != nil && it.custom.Key != "" {
		drawPicked(c, it.custom, geom.Rect{X: x, Y: mid - pickerPicture/2, W: pickerPicture, H: pickerPicture})
	} else {
		line := float32(pickerPicture * 1.5)
		c.Paint.Text(it.value, x, mid-line/2, line, pickerBigStyle, c.Theme.Muted)
	}
	x += pickerPicture + 6.4
	c.Paint.Text(":"+it.name+":", x, mid-pickerNameSize*0.75, pickerNameSize*1.5, pickerNameStyle, c.Theme.Muted)
}
