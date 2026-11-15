package channels

import (
	"context"
	"time"

	"harmony/v2/internal/arrange"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	mvDragStart      = 4
	mvHeadUpper      = 0.25
	mvLineThick      = 3
	mvRingSize       = 10
	mvRingEdge       = 3
	mvLineLift       = 2
	mvTagSize        = 11.52
	mvTagPadX        = 8
	mvTagPadY        = 1.6
	mvTagGap         = 4.8
	mvTagInset       = 4
	mvTagIconSize    = 11
	mvGroupTintAlpha = 0.1
	mvGroupBarWidth  = 3
	mvGroupIntoAlpha = 0.26
	mvGroupIntoEdge  = 2
	mvGroupLabelSize = 11.52
	mvDropoutHeight  = 49
	mvDropoutMargin  = 6.4
	mvDropoutRadius  = 10
	mvDropoutEdge    = 2
	mvDropoutAlpha   = 0.12
	mvDropoutSize    = 13.6
	mvDraggedDim     = 0.6
	mvArrangeTimeout = 15 * time.Second
	mvDropoutDashLen = 6
	mvDropoutDashGap = 4
)

// slot is where one row of the channel list was drawn this frame: the row itself, and the room around it that counts as being on it.
type slot struct {
	row   geom.Rect
	hit   geom.Rect
	group bool
	id    int
	in    int
	name  string
}

type dragPhase uint8

const (
	dragIdle dragPhase = iota
	dragPressed
	dragMoving
)

// channelDrag is moving a channel or a group in the list with the mouse: a press that has not moved is still a click.
type channelDrag struct {
	phase   dragPhase
	group   bool
	id      int
	kind    string
	from    int
	startX  float32
	startY  float32
	name    string
	icon    string
	slots   []slot
	view    geom.Rect
	dropout geom.Rect
	over    arrange.Drop
	line    geom.Rect
	into    int
	armed   bool
}

func (d *channelDrag) active() bool { return d.phase == dragMoving }

// outOfGroup is whether the way out of a group is on offer: a channel in a group is being moved.
func (d *channelDrag) outOfGroup() bool { return d.phase == dragMoving && !d.group && d.from != 0 }

func (d *channelDrag) begin(c *widget.Context, group bool, id int, kind string, from int, name, icon string) {
	*d = channelDrag{phase: dragPressed, group: group, id: id, kind: kind, from: from, startX: c.In.MouseX, startY: c.In.MouseY, name: name, icon: icon, slots: d.slots[:0], view: d.view}
}

// grow makes the room under the last row, the people in a voice channel, count as being on it.
func (d *channelDrag) grow(h float32) {
	if n := len(d.slots); n > 0 {
		d.slots[n-1].hit.H += h
	}
}

func (d *channelDrag) reset() {
	d.phase, d.over, d.into, d.line = dragIdle, arrange.Drop{}, 0, geom.Rect{}
}

func (d *channelDrag) record(r geom.Rect, extra float32, group bool, id, in int, name string) {
	d.slots = append(d.slots, slot{row: r, hit: geom.Rect{X: r.X, Y: r.Y - rowGap, W: r.W, H: r.H + extra + rowGap}, group: group, id: id, in: in, name: name})
}

// update runs once a frame after the rows are drawn: it starts the drag, follows it, and ends it with the move or the click.
func (s *Screen) updateDrag(c *widget.Context) {
	d := &s.admin.drag
	switch d.phase {
	case dragIdle:
		return
	case dragPressed:
		if c.In.Released || !c.In.Down {
			click := d.phase == dragPressed
			group, id, kind := d.group, d.id, d.kind
			d.reset()
			if click && c.In.Released {
				if group {
					s.toggleGroup(id)
				} else {
					s.pick(id, kind)
				}
			}
			return
		}
		dx, dy := c.In.MouseX-d.startX, c.In.MouseY-d.startY
		if dx*dx+dy*dy < mvDragStart*mvDragStart {
			return
		}
		d.phase = dragMoving
	}
	if c.EscapeBase() {
		d.reset()
		return
	}
	d.aim(c)
	d.paintMarks(c)
	if c.In.Released || !c.In.Down {
		to := d.over
		group, id := d.group, d.id
		d.reset()
		if to.Kind != arrange.None {
			s.move(group, id, to)
		}
	}
}

// aim finds where the thing being dragged would land with the mouse where it is.
func (d *channelDrag) aim(c *widget.Context) {
	d.over, d.line, d.into = arrange.Drop{}, geom.Rect{}, 0
	mx, my := c.In.MouseX, c.In.MouseY
	if d.outOfGroup() && d.dropout.Contains(mx, my) {
		d.over = arrange.Drop{Kind: arrange.AfterGroup, ID: d.from}
		return
	}
	if !d.view.Contains(mx, my) || len(d.slots) == 0 {
		return
	}
	last := d.slots[len(d.slots)-1]
	if my >= last.hit.Bottom() {
		d.over = arrange.Drop{Kind: arrange.End}
		first := d.slots[0].row
		d.line = geom.Rect{X: first.X, Y: last.hit.Bottom(), W: first.W}
		return
	}
	for i := range d.slots {
		sl := &d.slots[i]
		if my < sl.hit.Y || my >= sl.hit.Bottom() {
			continue
		}
		if d.group {
			d.aimGroup(sl)
		} else {
			d.aimChannel(sl, my)
		}
		return
	}
}

func (d *channelDrag) aimChannel(sl *slot, my float32) {
	if !sl.group {
		if sl.id == d.id {
			return
		}
		d.over = arrange.Drop{Kind: arrange.BeforeChannel, ID: sl.id}
		d.line = geom.Rect{X: sl.row.X, Y: sl.row.Y - mvLineLift, W: sl.row.W}
		d.into = sl.in
		return
	}
	if my < sl.row.Y+sl.row.H*mvHeadUpper {
		d.over = arrange.Drop{Kind: arrange.BeforeGroup, ID: sl.id}
		d.line = geom.Rect{X: sl.row.X, Y: sl.row.Y - mvLineLift, W: sl.row.W}
		return
	}
	d.over = arrange.Drop{Kind: arrange.IntoGroup, ID: sl.id}
	d.into = sl.id
	end := sl.row
	for i := range d.slots {
		if d.slots[i].in == sl.id {
			end = d.slots[i].row
		}
	}
	x := sl.row.X
	if end.Y != sl.row.Y {
		x = end.X
	} else {
		x += groupIndent
	}
	d.line = geom.Rect{X: x, Y: end.Bottom() + 1, W: sl.row.Right() - x}
}

func (d *channelDrag) aimGroup(sl *slot) {
	if sl.group {
		if sl.id == d.id {
			return
		}
		d.over = arrange.Drop{Kind: arrange.BeforeGroup, ID: sl.id}
		d.line = geom.Rect{X: sl.row.X, Y: sl.row.Y - mvLineLift, W: sl.row.W}
		return
	}
	if sl.in == d.id {
		return
	}
	d.over = arrange.Drop{Kind: arrange.BeforeChannel, ID: sl.id}
	if sl.in == 0 {
		d.line = geom.Rect{X: sl.row.X, Y: sl.row.Y - mvLineLift, W: sl.row.W}
		return
	}
	for i := range d.slots {
		if d.slots[i].group && d.slots[i].id == sl.in {
			head := d.slots[i].row
			d.line = geom.Rect{X: head.X, Y: head.Y - mvLineLift, W: head.W}
		}
	}
}

// paintMarks draws what the drop will do: the dimmed row, the tinted group, the way out, and a line with a tag where it lands.
func (d *channelDrag) paintMarks(c *widget.Context) {
	accent := c.Theme.Accent
	c.Paint.PushClip(d.view)
	for i := range d.slots {
		sl := &d.slots[i]
		if !sl.group && !d.group && sl.id == d.id || sl.group && d.group && sl.id == d.id {
			c.Paint.Fill(sl.row, rowRadius, theme.WithAlpha(c.Theme.Bg, mvDraggedDim))
		}
		if d.into == 0 || sl.group && sl.id != d.into || !sl.group && sl.in != d.into {
			continue
		}
		if sl.group && d.over.Kind == arrange.IntoGroup {
			c.Paint.Fill(sl.row, rowRadius, theme.WithAlpha(accent, mvGroupIntoAlpha))
			c.Paint.Stroke(sl.row, rowRadius, mvGroupIntoEdge, accent)
			d.paintInto(c, sl.row)
			continue
		}
		c.Paint.Fill(sl.row, 0, theme.WithAlpha(accent, mvGroupTintAlpha))
		c.Paint.Fill(geom.Rect{X: sl.row.X, Y: sl.row.Y, W: mvGroupBarWidth, H: sl.row.H}, 0, accent)
	}
	if d.line.W > 0 {
		d.paintLine(c)
	}
	c.Paint.PopClip()
}

func (d *channelDrag) paintInto(c *widget.Context, head geom.Rect) {
	name := ""
	for i := range d.slots {
		if d.slots[i].group && d.slots[i].id == d.into {
			name = d.slots[i].name
		}
	}
	text := c.T("channels.drop_into", "name", name)
	style := paint.TextStyle{Size: mvGroupLabelSize, Weight: paint.Semibold}
	w := c.Paint.TextWidth(text, style) + 2*mvTagPadX
	pill := geom.Rect{X: head.Right() - mvTagInset - w, Y: head.Y + (head.H-mvGroupLabelSize*1.5-2*mvTagPadY)/2, W: w, H: mvGroupLabelSize*1.5 + 2*mvTagPadY}
	c.Paint.Fill(pill, pill.H/2, c.Theme.Accent)
	c.Paint.Text(text, pill.X+mvTagPadX, pill.Y+mvTagPadY, mvGroupLabelSize*1.5, style, widget.ToneOnAccent.Color(c.Theme))
}

func (d *channelDrag) paintLine(c *widget.Context) {
	accent := c.Theme.Accent
	l := d.line
	c.Paint.Fill(geom.Rect{X: l.X, Y: l.Y - mvLineThick/2, W: l.W, H: mvLineThick}, mvLineThick/2, accent)
	ring := geom.Rect{X: l.X - mvTagInset, Y: l.Y - mvRingSize/2, W: mvRingSize, H: mvRingSize}
	c.Paint.Fill(ring, mvRingSize/2, accent)
	c.Paint.Fill(geom.Rect{X: ring.X + mvRingEdge, Y: ring.Y + mvRingEdge, W: mvRingSize - 2*mvRingEdge, H: mvRingSize - 2*mvRingEdge}, (mvRingSize-2*mvRingEdge)/2, c.Theme.Bg)

	style := paint.TextStyle{Size: mvTagSize, Weight: paint.Semibold}
	name := d.name
	room := l.W * 0.7
	w := min(c.Paint.TextWidth(name, style)+mvTagIconSize+mvTagGap+2*mvTagPadX, room)
	h := float32(mvTagSize*1.4 + 2*mvTagPadY)
	pill := geom.Rect{X: l.Right() - mvTagInset - w, Y: l.Y - h/2, W: w, H: h}
	c.Paint.Fill(pill, h/2, c.Theme.Accent)
	c.Paint.Icon(d.icon, geom.Rect{X: pill.X + mvTagPadX, Y: pill.Y + (h-mvTagIconSize)/2, W: mvTagIconSize, H: mvTagIconSize}, theme.WithAlpha(widget.ToneOnAccent.Color(c.Theme), 0.85))
	x := pill.X + mvTagPadX + mvTagIconSize + mvTagGap
	c.Paint.TextIn(geom.Rect{X: x, Y: pill.Y, W: pill.Right() - mvTagPadX - x, H: h}, name, x, pill.Y+(h-mvTagSize*1.4)/2, mvTagSize*1.4, style, widget.ToneOnAccent.Color(c.Theme))
}

// paintDropout draws the way out of a group under the list, while a channel in one is moved.
func (d *channelDrag) paintDropout(c *widget.Context) {
	if !d.outOfGroup() {
		return
	}
	r := d.dropout
	hot := d.over.Kind == arrange.AfterGroup
	if hot {
		c.Paint.Fill(r, mvDropoutRadius, theme.WithAlpha(c.Theme.Accent, mvDropoutAlpha))
	}
	edge := c.Theme.BorderStrong
	ink := c.Theme.Muted
	if hot {
		edge, ink = c.Theme.Accent, c.Theme.Text
	}
	c.Paint.DashedRoundRect(r, mvDropoutRadius, mvDropoutEdge, mvDropoutDashLen, mvDropoutDashGap, edge)
	style := paint.TextStyle{Size: mvDropoutSize, Weight: paint.Regular}
	text := c.T("channels.drop_out")
	c.Paint.TextIn(r, text, r.X+(r.W-c.Paint.TextWidth(text, style))/2, r.Y+(r.H-mvDropoutSize*1.5)/2, mvDropoutSize*1.5, style, ink)
}

// move sends the list as it would be with the drop made; the server tells everybody the result, this screen included.
func (s *Screen) move(group bool, id int, to arrange.Drop) {
	st := s.Session.State()
	nodes := arrange.Of(st.Channels, st.Groups)
	if group {
		s.send(arrange.MoveGroup(nodes, id, to))
	} else {
		s.send(arrange.MoveChannel(nodes, id, to))
	}
}

func (s *Screen) send(nodes []arrange.Node) {
	if nodes == nil {
		return
	}
	order := arrange.Placements(nodes)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), mvArrangeTimeout)
		defer cancel()
		s.fail(s.Session.Client().Arrange(ctx, order))
	}()
}
