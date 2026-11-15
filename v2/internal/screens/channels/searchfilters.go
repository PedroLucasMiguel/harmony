package channels

import (
	"image/color"
	"slices"
	"strconv"
	"strings"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	fdWidth       = 480
	fdMargin      = 24
	fdMaxShare    = 0.88
	fdBackdrop    = 153
	fdRadius      = 10
	fdEdgeAlpha   = 0.14
	fdPadX        = 19.2
	fdPadY        = 17.6
	fdTitleTop    = 16
	fdTitleBottom = 6.4
	fdTitleLine   = 24.56
	fdBodyTop     = 6.4
	fdBodyBottom  = 16
	fdSectionGap  = 16
	fdHeadLine    = 22.8
	fdHintLine    = 20.4
	fdControlGap  = 11.2
	fdPillsGap    = 6.4
	fdSelectH     = 31.2
	fdPillH       = 31.7
	fdPillGap     = 5.6
	fdPillPadX    = 11.2
	fdPillPadY    = 4.8
	fdKindAlpha   = 0.18
	fdDateGap     = 6.4
	fdDateKindW   = 112
	fdAddDateH    = 38.6
	fdFootPadY    = 12.8
	fdFootGap     = 8
	fdFootButton  = 40.7
	fdCross       = 24
)

var (
	fdTitleStyle = paint.TextStyle{Size: 16.38, Weight: paint.Bold}
	fdHeadStyle  = paint.TextStyle{Size: 15.2, Weight: paint.Bold}
	fdHintStyle  = paint.TextStyle{Size: 13.6, Weight: paint.Regular}
	fdKindStyle  = paint.TextStyle{Size: 13.6, Weight: paint.Regular}
)

type dateRow struct {
	kind  widget.Dropdown
	day   widget.TextField
	chip  *filter
	valid bool
}

// filtersDialog is "More filters": every filter in one place, changed on a copy until Apply.
type filtersDialog struct {
	s      *Screen
	m      model
	draft  []filter
	adds   [3]widget.Dropdown
	pinned widget.Dropdown
	dates  []*dateRow
	scroll widget.Scroll
	cancel widget.Button
	apply  widget.Button
	rev    int
	built  int
	body   fdBody
	closed bool

	clearText string
	nothing   bool
}

var addKeys = [3]string{"from", "in", "mentions"}

func (s *Screen) openFilters(m model) {
	q := &s.chat.find.search
	d := &filtersDialog{s: s, m: m}
	for _, f := range q.chips {
		d.draft = append(d.draft, f)
	}
	d.body.d = d
	d.scroll.Child, d.scroll.Bar = &d.body, true
	for i := range d.adds {
		key := addKeys[i]
		d.adds[i].OnChange = func(v string) {
			d.pick(key, v)
			d.rev++
		}
	}
	d.pinned.OnChange = func(v string) {
		d.draft = slices.DeleteFunc(d.draft, func(f filter) bool { return f.key == "pinned" })
		if v != "" {
			d.draft = append(d.draft, filter{key: "pinned", word: v, label: v})
		}
		d.rev++
	}
	for _, f := range d.draft {
		if f.key == "before" || f.key == "during" || f.key == "after" {
			d.addDate(f)
		}
	}
	d.cancel = widget.Button{Variant: widget.Ghost, OnClick: func() { d.closed = true }}
	d.apply = widget.Button{Variant: widget.Primary, OnClick: d.submit}
	s.chat.find.c.OpenModal(d)
}

func (d *filtersDialog) pick(key, v string) {
	if v == "" {
		return
	}
	switch key {
	case "from", "mentions":
		for _, a := range d.m.state.Members {
			if strconv.Itoa(a.ID) == v {
				d.draft = append(d.draft, filter{key: key, id: a.ID, label: a.Name()})
			}
		}
	case "in":
		for _, ch := range searchable(d.m) {
			if strconv.Itoa(ch.ID) == v {
				d.draft = append(d.draft, filter{key: key, id: ch.ID, label: ch.Name})
			}
		}
	}
}

func (d *filtersDialog) addDate(f filter) {
	row := &dateRow{}
	row.kind.Options = []widget.Option{{Value: "before", Label: ""}, {Value: "during", Label: ""}, {Value: "after", Label: ""}}
	row.kind.Value = f.key
	row.day.Inset = true
	row.day.SetValue(f.word)
	d.dates = append(d.dates, row)
}

// chosen is what Apply would search with: the draft's filters, with the dates as they are typed.
func (d *filtersDialog) chosen() []filter {
	var out []filter
	for _, f := range d.draft {
		if f.key != "before" && f.key != "during" && f.key != "after" {
			out = append(out, f)
		}
	}
	for _, row := range d.dates {
		if iso, ok := parseDate(row.day.Value); ok {
			out = append(out, filter{key: row.kind.Value, word: iso, label: iso})
		}
	}
	return out
}

func (d *filtersDialog) submit() {
	s := d.s
	q := &s.chat.find.search
	q.chips = d.chosen()
	d.closed = true
	text := strings.TrimSpace(q.field.Value)
	if text != "" || len(q.chips) > 0 {
		s.runSearch(text, 0, true)
	} else {
		q.closeResults()
	}
}

func (d *filtersDialog) Draw(c *widget.Context, bounds geom.Rect) {
	c.Layer(d)
	if d.closed || c.EscapeFor(d) {
		c.Claim()
		c.CloseModal()
		return
	}
	edge := c.Hairline()
	c.Paint.Fill(bounds, 0, color.RGBA{A: fdBackdrop})
	d.refresh(c)
	width := min(fdWidth, bounds.W-2*fdMargin)
	inner := width - 2*(fdPadX+edge)
	head := float32(fdTitleTop + fdTitleLine + fdTitleBottom)
	foot := edge + 2*fdFootPadY + fdFootButton
	body := fdBodyTop + d.body.Measure(c, inner-2*fdPadX).H + fdBodyBottom
	height := min(head+body+foot+2*(fdPadY+edge), fdMaxShare*bounds.H)
	card := geom.Rect{X: bounds.X + (bounds.W-width)/2, Y: bounds.Y + (bounds.H-height)/2, W: width, H: height}
	c.Popup(card)
	c.Paint.Fill(card, fdRadius, c.Theme.Surface2)
	c.Paint.Stroke(card, fdRadius, edge, theme.WithAlpha(c.Theme.Tint, fdEdgeAlpha))
	form := card.Inset(fdPadX+edge, fdPadY+edge, fdPadX+edge, fdPadY+edge)
	c.Paint.Text(c.T("search.dialog_title"), form.X+fdPadX, form.Y+fdTitleTop, fdTitleLine, fdTitleStyle, c.Theme.Text)
	area := geom.Rect{X: form.X, Y: form.Y + head, W: form.W, H: form.H - head - foot}
	d.body.view = area
	c.Paint.PushClip(area)
	d.scroll.Draw(c, geom.Rect{X: area.X + fdPadX, Y: area.Y + fdBodyTop, W: area.W - 2*fdPadX, H: area.H - fdBodyTop - fdBodyBottom})
	c.Paint.PopClip()
	d.drawFoot(c, geom.Rect{X: form.X, Y: form.Bottom() - foot, W: form.W, H: foot})
}

func (d *filtersDialog) refresh(c *widget.Context) {
	if d.built == d.rev+1 {
		return
	}
	d.built = d.rev + 1
	people := func(key string) []widget.Option {
		opts := []widget.Option{{Value: "", Label: c.T("search.add_person")}}
		taken := func(id int) bool {
			return slices.ContainsFunc(d.draft, func(f filter) bool { return f.key == key && f.id == id })
		}
		list := slices.Clone(d.m.state.Members)
		slices.SortFunc(list, func(a, b hclient.Account) int {
			return strings.Compare(strings.ToLower(a.Name()), strings.ToLower(b.Name()))
		})
		for _, a := range list {
			if !taken(a.ID) {
				opts = append(opts, widget.Option{Value: strconv.Itoa(a.ID), Label: a.Name()})
			}
		}
		return opts
	}
	d.adds[0].Options, d.adds[2].Options = people("from"), people("mentions")
	channels := []widget.Option{{Value: "", Label: c.T("search.add_channel")}}
	for _, ch := range searchable(d.m) {
		if !slices.ContainsFunc(d.draft, func(f filter) bool { return f.key == "in" && f.id == ch.ID }) {
			channels = append(channels, widget.Option{Value: strconv.Itoa(ch.ID), Label: ch.Name})
		}
	}
	d.adds[1].Options = channels
	for i := range d.adds {
		d.adds[i].Value = ""
	}
	d.pinned.Options = []widget.Option{{Value: "", Label: c.T("search.any")}, {Value: "true", Label: c.T("search.true")}, {Value: "false", Label: c.T("search.false")}}
	d.pinned.Value = ""
	for _, f := range d.draft {
		if f.key == "pinned" {
			d.pinned.Value = f.word
		}
	}
	for _, row := range d.dates {
		for i, k := range []string{"before", "during", "after"} {
			row.kind.Options[i].Label = c.T("search.date_" + k)
		}
	}
	d.clearText = c.T("search.dialog_clear", "count", strconv.Itoa(len(d.chosen())))
	d.nothing = len(d.chosen()) == 0
	d.cancel.Label, d.apply.Label = c.T("app.cancel"), c.T("search.apply")
}

func (d *filtersDialog) drawFoot(c *widget.Context, r geom.Rect) {
	edge := c.Hairline()
	c.Paint.Fill(geom.Rect{X: r.X, Y: r.Y, W: r.W, H: edge}, 0, c.Theme.Border)
	y := r.Y + edge + fdFootPadY
	right := r.Right() - fdPadX
	for _, b := range []*widget.Button{&d.apply, &d.cancel} {
		size := b.Measure(c, 0)
		right -= size.W
		b.Draw(c, geom.Rect{X: right, Y: y, W: size.W, H: fdFootButton})
		right -= fdFootGap
	}
	d.drawClear(c, geom.Rect{X: r.X + fdPadX, Y: y, W: 0, H: fdFootButton})
}

// fdBody is the filters' sections, one under another.
type fdBody struct {
	d    *filtersDialog
	view geom.Rect
}

func (b *fdBody) pillsHeight(c *widget.Context, key string, width float32) float32 {
	d := b.d
	n := 0
	for _, f := range d.draft {
		if f.key == key {
			n++
		}
	}
	if n == 0 {
		return 0
	}
	return fdPillH
}

func (b *fdBody) sectionHeight(c *widget.Context, section int, width float32) float32 {
	d := b.d
	head := float32(fdHeadLine + fdHintLine + fdControlGap)
	switch section {
	case 0, 1, 3:
		key := addKeys[[...]int{0, 1, 0, 2}[section]]
		return head + b.pillsHeight(c, key, width) + fdPillsGap + fdSelectH
	case 2:
		return head + fdPillH + fdPillsGap
	case 4:
		h := head + fdPillsGap + fdAddDateH
		if n := len(d.dates); n > 0 {
			h += float32(n)*fdSelectH + float32(n-1)*fdDateGap
		}
		return h
	}
	return head + fdSelectH
}

const fdSections = 6

func (b *fdBody) Measure(c *widget.Context, maxWidth float32) geom.Size {
	h := float32(0)
	for i := range fdSections {
		if i > 0 {
			h += fdSectionGap
		}
		h += b.sectionHeight(c, i, maxWidth)
	}
	return geom.Size{W: maxWidth, H: h}
}

func (b *fdBody) Draw(c *widget.Context, r geom.Rect) {
	d := b.d
	y := r.Y
	titles := [fdSections][2]string{
		{"search.dialog_from", "search.dialog_from_hint"}, {"search.dialog_in", "search.dialog_in_hint"},
		{"search.dialog_has", "search.dialog_has_hint"}, {"search.dialog_mentions", "search.dialog_mentions_hint"},
		{"search.dialog_date", "search.dialog_date_hint"}, {"search.dialog_pinned", "search.dialog_pinned_hint"},
	}
	for i := range fdSections {
		if i > 0 {
			y += fdSectionGap
		}
		h := b.sectionHeight(c, i, r.W)
		c.Paint.Text(c.T(titles[i][0]), r.X, y, fdHeadLine, fdHeadStyle, c.Theme.Text)
		c.Paint.Text(c.T(titles[i][1]), r.X, y+fdHeadLine, fdHintLine, fdHintStyle, c.Theme.Muted)
		at := y + fdHeadLine + fdHintLine + fdControlGap
		area := geom.Rect{X: r.X, Y: at, W: r.W}
		switch i {
		case 0, 1, 3:
			b.drawPicker(c, area, i)
		case 2:
			b.drawKinds(c, area)
		case 4:
			b.drawDates(c, area)
		default:
			d.pinned.Draw(c, geom.Rect{X: area.X, Y: area.Y, W: area.W, H: fdSelectH})
		}
		y += h
	}
}

func (b *fdBody) drawPicker(c *widget.Context, r geom.Rect, section int) {
	d := b.d
	key := addKeys[[...]int{0, 1, 0, 2}[section]]
	x, y := r.X, r.Y
	if b.pillsHeight(c, key, r.W) > 0 {
		for i := 0; i < len(d.draft); i++ {
			f := d.draft[i]
			if f.key != key {
				continue
			}
			fc := widget.FilterChip{Key: "", Value: f.label}
			size := fc.Measure(c)
			if x+size.W > r.Right() && x > r.X {
				x, y = r.X, y+size.H+fdPillGap
			}
			if fc.Show(c, geom.Rect{X: x, Y: y + (fdPillH-size.H)/2, W: size.W, H: size.H}) {
				d.draft = slices.Delete(d.draft, i, i+1)
				d.rev++
				return
			}
			x += size.W + fdPillGap
		}
		y = r.Y + fdPillH
	}
	d.adds[[...]int{0, 1, 0, 2}[section]].Draw(c, geom.Rect{X: r.X, Y: y + fdPillsGap, W: r.W, H: fdSelectH})
}

func (b *fdBody) drawKinds(c *widget.Context, r geom.Rect) {
	d := b.d
	x := r.X
	for _, kind := range hasKinds {
		label := c.T("search." + "has_" + kind)
		w := c.Paint.TextWidth(label, fdKindStyle) + 2*fdPillPadX + 2*c.Hairline()
		box := geom.Rect{X: x, Y: r.Y, W: w, H: fdPillH}
		at := slices.IndexFunc(d.draft, func(f filter) bool { return f.key == "has" && f.word == kind })
		fill, edge := c.Theme.Bg, c.Theme.Border
		if at >= 0 {
			fill, edge = theme.WithAlpha(c.Theme.Accent, fdKindAlpha), c.Theme.Accent
		}
		hovered := c.Hovered(box.Intersect(b.view))
		c.Paint.Fill(box, fdPillH/2, fill)
		c.Paint.Stroke(box, fdPillH/2, c.Hairline(), edge)
		c.Paint.Text(label, box.X+fdPillPadX+c.Hairline(), box.Y+(fdPillH-fdKindStyle.Size*1.5)/2, fdKindStyle.Size*1.5, fdKindStyle, c.Theme.Text)
		if hovered {
			c.SetCursor(rl.MouseCursorPointingHand)
			if c.In.Pressed {
				c.Claim()
				if at >= 0 {
					d.draft = slices.Delete(d.draft, at, at+1)
				} else {
					d.draft = append(d.draft, filter{key: "has", word: kind, label: kind})
				}
				d.rev++
			}
		}
		x += w + fdPillGap
	}
}

func (b *fdBody) drawDates(c *widget.Context, r geom.Rect) {
	d := b.d
	y := r.Y
	for i, row := range d.dates {
		kind := geom.Rect{X: r.X, Y: y, W: fdDateKindW, H: fdSelectH}
		row.kind.Draw(c, kind)
		cross := geom.Rect{X: r.Right() - fdCross, Y: y + (fdSelectH-fdCross)/2, W: fdCross, H: fdCross}
		_, ok := parseDate(row.day.Value)
		row.day.Invalid = row.day.Value != "" && !ok
		row.day.Placeholder = "YYYY-MM-DD"
		row.day.Draw(c, geom.Rect{X: kind.Right() + fdDateGap, Y: y - (33.9-fdSelectH)/2, W: cross.X - fdDateGap - kind.Right() - fdDateGap, H: 33.9})
		hot := c.Hovered(cross.Intersect(b.view))
		alpha := float32(0.6)
		if hot {
			alpha = 1
			c.SetCursor(rl.MouseCursorPointingHand)
			c.Paint.Fill(cross, 4, theme.WithAlpha(c.Theme.Tint, 0.15))
		}
		c.Paint.Icon("x", geom.Rect{X: cross.X + (fdCross-14)/2, Y: cross.Y + (fdCross-14)/2, W: 14, H: 14}, theme.WithAlpha(c.Theme.Text, alpha))
		if hot && c.In.Pressed {
			c.Claim()
			d.dates = slices.Delete(d.dates, i, i+1)
			d.rev++
			return
		}
		y += fdSelectH + fdDateGap
	}
	if len(d.dates) > 0 {
		y += fdPillsGap - fdDateGap
	} else {
		y = r.Y + fdPillsGap
	}
	add := geom.Rect{X: r.X, Y: y, W: r.W, H: fdAddDateH}
	c.Paint.Fill(add, 8, theme.WithAlpha(c.Theme.Tint, 0.08))
	label := c.T("search.add_date")
	w := 16.8 + 4.8 + c.Paint.TextWidth(label, paint.TextStyle{Size: 14, Weight: paint.Regular})
	x := add.X + (add.W-w)/2
	c.Paint.Icon("plus", geom.Rect{X: x, Y: add.Y + (add.H-14)/2, W: 14, H: 14}, c.Theme.Text)
	c.Paint.Text(label, x+16.8+4.8, add.Y+(add.H-21)/2, 21, paint.TextStyle{Size: 14, Weight: paint.Regular}, c.Theme.Text)
	if c.Hovered(add.Intersect(b.view)) {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.In.Pressed {
			c.Claim()
			d.addDate(filter{key: "after", word: time.Now().Format(dayLayout)})
			d.rev++
		}
	}
}

// drawClear is the plain accent words that take every filter away; they are dim when there is none.
func (d *filtersDialog) drawClear(c *widget.Context, r geom.Rect) {
	style := paint.TextStyle{Size: 14, Weight: paint.Regular}
	w := c.Paint.TextWidth(d.clearText, style)
	box := geom.Rect{X: r.X, Y: r.Y + (r.H-21)/2, W: w, H: 21}
	ink := c.Theme.Accent
	if d.nothing {
		c.Paint.Text(d.clearText, box.X, box.Y, 21, style, theme.WithAlpha(ink, 0.45))
		return
	}
	if c.Hovered(box) {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.In.Pressed {
			c.Claim()
			d.draft, d.dates = nil, nil
			d.rev++
		}
	}
	c.Paint.Text(d.clearText, box.X, box.Y, 21, style, ink)
}
