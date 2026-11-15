package channels

import (
	"slices"
	"strconv"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	groupHeight     = 30.1
	groupAbove      = 6.6
	groupPadX       = 8
	groupPadY       = 6.4
	groupGap        = 8
	groupSize       = 11.52
	groupFoldW      = 5.5
	groupFoldHalf   = 2.1
	groupFoldRise   = 1.3
	groupFoldDrop   = 0.4
	groupIndent     = 17.6
	groupRuleWidth  = 1.74
	groupRuleAlpha  = 0.12
	groupSpacing    = groupSize * 0.06
	badgeSize       = 11.2
	badgePadX       = 5.6
	badgePadY       = 2.4
	badgeMinWidth   = 22.4
	badgeCapMention = 99
)

// layoutItem is one thing in the channel list: a channel on its own, or a group heading with its channels.
type layoutItem struct {
	channel  hclient.Channel
	group    *hclient.Group
	channels []hclient.Channel
	position int
}

// buildLayout sets the channels and groups in order of position; a channel in a group not heard of yet is left ungrouped.
func buildLayout(items []layoutItem, channels []hclient.Channel, groups []hclient.Group) []layoutItem {
	grouped := make([]layoutItem, 0, len(groups))
	for i := range groups {
		grouped = append(grouped, layoutItem{group: &groups[i], position: groups[i].Position})
	}
	for _, ch := range channels {
		if ch.GroupID != nil {
			if at := slices.IndexFunc(grouped, func(it layoutItem) bool { return it.group.ID == *ch.GroupID }); at >= 0 {
				grouped[at].channels = append(grouped[at].channels, ch)
				continue
			}
		}
		items = append(items, layoutItem{channel: ch, position: ch.Position})
	}
	items = append(items, grouped...)
	slices.SortStableFunc(items, func(a, b layoutItem) int { return a.position - b.position })
	return items
}

func (s *Screen) toggleGroup(id int) {
	if s.folded == nil {
		s.folded = map[int]bool{}
	}
	s.folded[id] = !s.folded[id]
}

type groupRow struct {
	screen   *Screen
	id       int
	name     string
	folded   bool
	mentions int
	actor    *hclient.Actor
}

func (g *groupRow) height() float32 { return groupAbove + groupHeight }

func (g *groupRow) Draw(c *widget.Context, r geom.Rect) {
	b := geom.Rect{X: r.X, Y: r.Y + groupAbove, W: r.W, H: groupHeight}
	g.screen.admin.drag.record(b, 0, true, g.id, 0, g.name)
	hovered := c.Hovered(b)
	ink := c.Theme.Muted
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
		c.Paint.Fill(b, rowRadius, theme.WithAlpha(c.Theme.Tint, hoverAlpha))
		ink = c.Theme.Text
	}
	cx, cy := b.X+groupPadX+groupFoldW/2, b.Y+b.H/2+groupFoldDrop
	if g.folded {
		c.Paint.Triangle([2]float32{cx - groupFoldRise, cy - groupFoldHalf}, [2]float32{cx - groupFoldRise, cy + groupFoldHalf}, [2]float32{cx + groupFoldRise + 0.4, cy}, ink)
	} else {
		c.Paint.Triangle([2]float32{cx - groupFoldHalf, cy - groupFoldRise}, [2]float32{cx, cy + groupFoldRise + 0.4}, [2]float32{cx + groupFoldHalf, cy - groupFoldRise}, ink)
	}
	right := b.Right() - groupPadX
	if g.mentions > 0 {
		right -= drawMentionBadge(c, g.mentions, right, b.Y+b.H/2) + groupGap
	}
	x := b.X + groupPadX + groupFoldW + groupGap
	style := paint.TextStyle{Size: groupSize, Weight: paint.Bold, Spacing: groupSpacing}
	c.Paint.TextIn(geom.Rect{X: x, Y: b.Y, W: right - x, H: b.H}, widget.Upper(g.name), x, b.Y+groupPadY, groupSize*1.5, style, ink)
	if hovered && c.Clicked(b) {
		c.Claim()
		g.screen.press(c, g.actor, true, g.id, "", 0, g.name, "")
	}
	if hovered && c.In.RightPressed {
		g.screen.groupMenu(c, *g.actor, g.id, g.name)
	}
}

// drawMentionBadge draws "@ n" ending at right, centred on cy, and returns its width.
func drawMentionBadge(c *widget.Context, n int, right, cy float32) float32 {
	text := "@ " + countText(n)
	style := paint.TextStyle{Size: badgeSize, Weight: paint.Bold}
	w := max(badgeMinWidth, c.Paint.TextWidth(text, style)+2*badgePadX)
	box := geom.Rect{X: right - w, Y: cy - (badgeSize+2*badgePadY)/2, W: w, H: badgeSize + 2*badgePadY}
	c.Paint.Fill(box, box.H/2, c.Theme.Warn)
	tw := c.Paint.TextWidth(text, style)
	c.Paint.Text(text, box.X+(w-tw)/2, box.Y+badgePadY, badgeSize, style, c.Theme.Bg)
	return w
}

func countText(n int) string {
	if n > badgeCapMention {
		return "99+"
	}
	return strconv.Itoa(n)
}
