package profilecard

import (
	"fmt"
	"image/color"
	"strings"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/people"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	handleSize    = smallSize
	badgeTop      = 6.4
	badgePad      = 3.2
	badgeBox      = 24 + 2*badgePad + 1.74
	badgeGap      = 4.8
	rolesTop      = 9.6
	rolesPad      = 9.6
	labelSize     = 11.2
	labelLine     = 16.8
	labelAfter    = 6.4
	chipSize      = 12.8
	chipLine      = chipSize * 1.5
	chipPadX      = 7.04
	chipPadY      = 1.28
	chipDot       = 8.96
	chipDotGap    = 3.84
	chipGap       = 5.6
	chipX         = 12
	pickPad       = 3.2
	pickRow       = 28
	pickTop       = 6.4
	pickMax       = 6
	noteSize      = 12.5
	tipWidth      = 208
	tipPadX       = 12.8
	tipPadY       = 14.4
	tipGap        = 5.6
	tipBadge      = 72
	tipRadius     = 10
	tipTitleSize  = 16
	tipTextSize   = 13.6
	tipAbove      = 8
	roleIconInset = 4
	bannerAccent  = 0.35
)

var (
	nameStyle             = paint.TextStyle{Size: nameSize, Weight: paint.Bold}
	smallStyle            = paint.TextStyle{Size: smallSize, Weight: paint.Regular}
	labelStyle            = paint.TextStyle{Size: labelSize, Weight: paint.Bold, Spacing: labelSize * 0.06}
	chipStyle             = paint.TextStyle{Size: chipSize, Weight: paint.Regular}
	tipTitle              = paint.TextStyle{Size: tipTitleSize, Weight: paint.Bold, Spacing: tipTitleSize * 0.04}
	tipText               = paint.TextStyle{Size: tipTextSize, Weight: paint.Regular}
	noteStyle             = paint.TextStyle{Size: noteSize, Weight: paint.Regular}
	nameLine      float32 = nameSize * 1.3
	months                = map[string][12]string{"es": {"enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"}, "pt": {"janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"}}
	monthsEnglish         = [12]string{"January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"}
)

func (v *view) since(c *widget.Context) string {
	if v.e.CreatedAt == 0 {
		return ""
	}
	t := time.UnixMilli(v.e.CreatedAt)
	names := monthsEnglish
	if m, ok := months[strings.SplitN(c.Strings.Code(), "-", 2)[0]]; ok {
		names = m
	}
	return c.T("profile_card.member_since", "date", fmt.Sprintf("%s %d", names[t.Month()-1], t.Year()))
}

func (v *view) chipWidth(c *widget.Context, name string, removable bool) float32 {
	w := 2*(chipPadX+c.Hairline()) + chipDot + chipDotGap + c.Paint.TextWidth(name, chipStyle)
	if removable {
		w += chipDotGap + chipX
	}
	return w
}

// roleRows lays the role chips out in rows within width and says where each one goes; with a nil place it only counts the rows.
func (v *view) roleRows(c *widget.Context, width float32, place func(i int, x, row float32, w float32)) (rows int) {
	x, row := float32(0), 0
	items := len(v.held)
	if len(v.addable) > 0 {
		items++
	}
	for i := 0; i < items; i++ {
		w := float32(chipLine + 2*(chipPadY+c.Hairline()))
		if i < len(v.held) {
			w = v.chipWidth(c, v.held[i].Name, v.removable(i))
		}
		if x > 0 && x+w > width {
			x, row = 0, row+1
		}
		if place != nil {
			place(i, x, float32(row), w)
		}
		x += w + chipGap
	}
	if items > 0 {
		rows = row + 1
	}
	return rows
}

func (v *view) removable(i int) bool { return v.above && v.actor.CanAssign(v.held[i]) }

func (v *view) chipHeight(c *widget.Context) float32 { return chipLine + 2*(chipPadY+c.Hairline()) }

func (v *view) height(c *widget.Context, width float32) float32 {
	h := float32(bannerHeight + bodyPadTop + nameLine + bodyGap + smallLine)
	if len(v.badges) > 0 {
		h += badgeTop + badgeBox
	}
	if v.since(c) != "" {
		h += bodyGap + smallLine
	}
	h += bodyGap + rolesTop + c.Hairline() + rolesPad + labelLine + labelAfter
	inner := width - 2*bodyPadSide
	if rows := v.roleRows(c, inner, nil); rows > 0 {
		h += float32(rows)*v.chipHeight(c) + float32(rows-1)*chipGap
	} else {
		h += smallLine
	}
	if v.k.adding && len(v.addable) > 0 {
		h += pickTop + 2*pickPad + float32(min(len(v.addable), pickMax))*pickRow
	}
	if v.k.note != "" {
		h += chipGap + noteSize*1.5
	}
	return h + bodyPadEnd + 2*c.Hairline()
}

func (v *view) draw(c *widget.Context, box geom.Rect) {
	k := v.k
	c.Paint.Shadow(box, cardRadius, cardShadowY, cardShadowBlur, color.RGBA{A: cardShadowA})
	c.Paint.Fill(box, cardRadius, c.Theme.Surface)
	edge := c.Hairline()
	v.drawBanner(c, geom.Rect{X: box.X + edge, Y: box.Y + edge, W: box.W - 2*edge, H: bannerHeight})
	c.Paint.Stroke(box, cardRadius, edge, c.Theme.BorderStrong)
	v.drawActions(c, box)
	v.drawFace(c, box)

	x := box.X + edge + bodyPadSide
	inner := box.W - 2*edge - 2*bodyPadSide
	y := box.Y + edge + bannerHeight + bodyPadTop
	clip := geom.Rect{X: x, Y: y, W: inner, H: nameLine}
	c.Paint.PushClip(clip)
	c.DrawName(v.e.Name(), &v.e.Style, x, y, nameLine, nameStyle, c.Theme.Text)
	c.Paint.PopClip()
	y += nameLine + bodyGap
	c.Paint.Text(v.e.Nickname, x, y, smallLine, smallStyle, c.Theme.Muted)
	if v.e.Role == "owner" || v.e.Role == "admin" {
		w := c.Paint.TextWidth(v.e.Nickname, smallStyle) + roleIconInset
		widget.RoleIcon{Owner: v.e.Role == "owner"}.Draw(c, geom.Rect{X: x + w, Y: y + 1, W: 17.6, H: smallLine - 2})
	}
	y += smallLine
	if len(v.badges) > 0 {
		y += badgeTop
		v.drawBadges(c, x, y)
		y += badgeBox
	}
	if since := v.since(c); since != "" {
		y += bodyGap
		c.Paint.Text(since, x, y, smallLine, smallStyle, c.Theme.Muted)
		y += smallLine
	}
	y += bodyGap + rolesTop
	c.Paint.Fill(geom.Rect{X: x, Y: y, W: inner, H: edge}, 0, c.Theme.Border)
	y += edge + rolesPad
	c.Paint.Text(widget.Upper(c.T("profile_card.roles")), x, y, labelLine, labelStyle, c.Theme.Muted)
	y += labelLine + labelAfter
	y = v.drawRoles(c, x, y, inner)
	if k.adding && len(v.addable) > 0 {
		y = v.drawPick(c, x, y+pickTop, inner)
	}
	if k.note != "" {
		c.Paint.Text(k.note, x, y+chipGap, noteSize*1.5, noteStyle, c.Theme.Danger)
	}
	v.drawTip(c, box)
}

func (v *view) drawBanner(c *widget.Context, r geom.Rect) {
	if hash := v.e.BannerHash; hash != "" && c.Faces != nil {
		w, h := c.Paint.PixelSize(r.W), c.Paint.PixelSize(r.H)
		tint := uint8(255)
		if dim := v.e.Dim(); dim > 0 {
			tint = uint8(255 * (1 - dim))
		}
		if c.Paint.DrawSizedTint(c.Paint.Sized(paint.Cover, hash, w, h, c.Faces), r, color.RGBA{tint, tint, tint, 255}) {
			c.Paint.TopCorners(r, cardRadius, c.Theme.Surface)
			return
		}
	}
	c.Paint.Fill(r, 0, theme.WithAlpha(c.Theme.Accent, bannerAccent))
	if len(v.held) > 0 {
		if col, ok := roleColor(v.held[0]); ok {
			c.Paint.Fill(r, 0, col)
		}
	}
	c.Paint.TopCorners(r, cardRadius, c.Theme.Surface)
}

func (v *view) drawActions(c *widget.Context, box geom.Rect) {
	k := v.k
	type action struct {
		icon string
		run  func(*widget.Context, int)
	}
	var actions [2]action
	n := 0
	if !v.mine && k.Message != nil && k.CanMessage() {
		actions[n], n = action{"chat-circle-dots", k.Message}, n+1
	}
	if !v.mine && k.Manage != nil && k.CanManage(v.e.ID) {
		actions[n], n = action{"gear-six", k.Manage}, n+1
	}
	x := box.Right() - c.Hairline() - actionsInset
	for i := n - 1; i >= 0; i-- {
		r := geom.Rect{X: x - actionW, Y: box.Y + c.Hairline() + actionsInset, W: actionW, H: actionH}
		x -= actionW + actionGap
		hovered := c.Hovered(r)
		plate := color.RGBA{A: actionPlate}
		if hovered {
			c.SetCursor(rl.MouseCursorPointingHand)
			plate = color.RGBA{A: 190}
		}
		c.Paint.Fill(r, actionRadius, plate)
		c.Paint.Stroke(r, actionRadius, c.Hairline(), c.Theme.Border)
		c.Paint.Icon(actions[i].icon, geom.Rect{X: r.X + (r.W-actionGlyph)/2, Y: r.Y + (r.H-actionGlyph)/2, W: actionGlyph, H: actionGlyph}, c.Theme.Text)
		if c.Clicked(r) {
			c.Claim()
			k.Close()
			actions[i].run(c, v.e.ID)
			return
		}
	}
}

func (v *view) drawFace(c *widget.Context, box geom.Rect) {
	edge := c.Hairline()
	ring := faceRing
	disc := geom.Rect{X: box.X + edge + faceLeft, Y: box.Y + edge + faceTop, W: faceInner + 2*float32(ring), H: faceInner + 2*float32(ring)}
	c.Paint.Fill(disc, disc.W/2, c.Theme.Surface)
	widget.Avatar{ID: v.e.ID, Name: v.e.Name(), Size: faceInner, Font: faceFont}.Draw(c, geom.Rect{X: disc.X + float32(ring), Y: disc.Y + float32(ring), W: faceInner, H: faceInner})
	dot := geom.Rect{X: disc.X + statusX, Y: disc.Y + statusY, W: statusSize, H: statusSize}
	c.Paint.Circle(dot.X+dot.W/2, dot.Y+dot.H/2, dot.W/2, c.Theme.Surface)
	c.Paint.Circle(dot.X+dot.W/2, dot.Y+dot.H/2, dot.W/2-statusRing, statusColor(c, v.online, v.status))
}

func (v *view) drawBadges(c *widget.Context, x, y float32) {
	hovered := 0
	for i, b := range v.badges {
		r := geom.Rect{X: x + float32(i)*(badgeBox+badgeGap), Y: y, W: badgeBox, H: badgeBox}
		on := c.Hovered(r)
		edge := c.Theme.Border
		if on {
			hovered = b.ID
			edge = c.Theme.Accent
			c.SetCursor(rl.MouseCursorPointingHand)
		}
		c.Paint.Fill(r, 8, theme.WithAlpha(c.Theme.Tint, 0.06))
		c.Paint.Stroke(r, 8, c.Hairline(), edge)
		widget.BadgeIcon{Emoji: b.EmojiText(), Hash: b.Image()}.Draw(c, geom.Rect{X: r.X + badgePad + 0.87, Y: r.Y + badgePad + 0.87, W: 24, H: 24})
		if on {
			v.k.tipAt = r
		}
	}
	v.k.tip = hovered
}

func (v *view) drawRoles(c *widget.Context, x, y, width float32) float32 {
	if len(v.held) == 0 && len(v.addable) == 0 {
		c.Paint.Text(c.T("profile_card.no_roles"), x, y, smallLine, smallStyle, c.Theme.Muted)
		return y + smallLine
	}
	k := v.k
	h := v.chipHeight(c)
	rows := v.roleRows(c, width, func(i int, cx, row, w float32) {
		r := geom.Rect{X: x + cx, Y: y + row*(h+chipGap), W: w, H: h}
		if i == len(v.held) {
			v.drawAdd(c, r)
			return
		}
		role := v.held[i]
		c.Paint.Stroke(r, h/2, c.Hairline(), c.Theme.Border)
		c.Paint.Fill(r.InsetAll(c.Hairline()), h/2, theme.WithAlpha(c.Theme.Tint, 0.06))
		inner := r.InsetAll(c.Hairline())
		col, ok := roleColor(role)
		if !ok {
			col = c.Theme.Muted
		}
		c.Paint.Fill(geom.Rect{X: inner.X + chipPadX, Y: inner.Y + (inner.H-chipDot)/2, W: chipDot, H: chipDot}, chipDot/2, col)
		tx := inner.X + chipPadX + chipDot + chipDotGap
		c.Paint.Text(role.Name, tx, inner.Y, inner.H, chipStyle, c.Theme.Text)
		if v.removable(i) {
			cross := geom.Rect{X: r.Right() - c.Hairline() - chipPadX/2 - chipX/2 - 2, Y: r.Y + (r.H-chipX)/2, W: chipX, H: chipX}
			ink := c.Theme.Muted
			if c.Hovered(cross) {
				ink = c.Theme.Text
				c.SetCursor(rl.MouseCursorPointingHand)
				if c.Clicked(cross) {
					c.Claim()
					k.setRoles(c, v.e.ID, v.without(role.ID))
				}
			}
			c.Paint.Icon("x", cross, ink)
		}
	})
	return y + float32(rows)*h + float32(rows-1)*chipGap
}

func (v *view) drawAdd(c *widget.Context, r geom.Rect) {
	hovered := c.Hovered(r)
	c.Paint.Stroke(r, r.H/2, c.Hairline(), c.Theme.Border)
	c.Paint.Fill(r.InsetAll(c.Hairline()), r.H/2, theme.WithAlpha(c.Theme.Tint, 0.06))
	ink := c.Theme.Muted
	if hovered {
		ink = c.Theme.Text
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(r) {
			c.Claim()
			v.k.adding = !v.k.adding
		}
	}
	side := float32(12)
	c.Paint.Icon("plus", geom.Rect{X: r.X + (r.W-side)/2, Y: r.Y + (r.H-side)/2, W: side, H: side}, ink)
}

func (v *view) without(id int) []int {
	ids := make([]int, 0, len(v.held))
	for _, r := range v.held {
		if r.ID != id {
			ids = append(ids, r.ID)
		}
	}
	return ids
}

func (v *view) drawPick(c *widget.Context, x, y, width float32) float32 {
	n := min(len(v.addable), pickMax)
	box := geom.Rect{X: x, Y: y, W: width, H: 2*pickPad + float32(n)*pickRow}
	c.Paint.Stroke(box, 8, c.Hairline(), c.Theme.Border)
	for i := 0; i < n; i++ {
		role := v.addable[i]
		row := geom.Rect{X: box.X + pickPad, Y: box.Y + pickPad + float32(i)*pickRow, W: box.W - 2*pickPad, H: pickRow}
		if c.Hovered(row) {
			c.SetCursor(rl.MouseCursorPointingHand)
			c.Paint.Fill(row, 6, theme.WithAlpha(c.Theme.Tint, 0.08))
			if c.Clicked(row) {
				c.Claim()
				v.k.setRoles(c, v.e.ID, append(v.without(0), role.ID))
			}
		}
		col, ok := roleColor(role)
		if !ok {
			col = c.Theme.Muted
		}
		c.Paint.Fill(geom.Rect{X: row.X + 9.6, Y: row.Y + (row.H-chipDot)/2, W: chipDot, H: chipDot}, chipDot/2, col)
		c.Paint.Text(role.Name, row.X+9.6+chipDot+chipDotGap+2, row.Y, row.H, smallStyle, c.Theme.Text)
	}
	return box.Bottom()
}

// drawTip is what a badge is, over the badge the pointer is on.
func (v *view) drawTip(c *widget.Context, _ geom.Rect) {
	if v.k.tip == 0 {
		return
	}
	i := -1
	for j, b := range v.badges {
		if b.ID == v.k.tip {
			i = j
		}
	}
	if i < 0 {
		return
	}
	b := v.badges[i]
	h := float32(tipPadY*2 + tipBadge + tipGap + tipTitleSize*1.5)
	if b.Description != "" {
		h += tipGap + tipTextSize*1.5
	}
	a := v.k.tipAt
	x := min(max(8, a.X+a.W/2-tipWidth/2), c.Viewport.W-tipWidth-8)
	y := a.Y - h - tipAbove
	if y < 8 {
		y = a.Bottom() + tipAbove
	}
	r := geom.Rect{X: x, Y: y, W: tipWidth, H: h}
	c.Paint.Shadow(r, tipRadius, cardShadowY, cardShadowBlur, color.RGBA{A: cardShadowA})
	c.Paint.Fill(r, tipRadius, c.Theme.Surface)
	c.Paint.Stroke(r, tipRadius, c.Hairline(), c.Theme.BorderStrong)
	cy := r.Y + tipPadY
	large := widget.BadgeIcon{Emoji: b.EmojiText(), Hash: b.Image(), Size: tipBadge}
	large.Draw(c, geom.Rect{X: r.X + (r.W-tipBadge)/2, Y: cy, W: tipBadge, H: tipBadge})
	cy += tipBadge + tipGap
	name := widget.Upper(b.Name)
	nw := c.Paint.TextWidth(name, tipTitle)
	c.Paint.Text(name, r.X+(r.W-nw)/2, cy, tipTitleSize*1.5, tipTitle, c.Theme.Text)
	if b.Description != "" {
		cy += tipTitleSize*1.5 + tipGap
		dw := c.Paint.TextWidth(b.Description, tipText)
		c.Paint.TextIn(geom.Rect{X: r.X + tipPadX, Y: cy, W: tipWidth - 2*tipPadX, H: tipTextSize * 1.5}, b.Description, r.X+max(tipPadX, (r.W-dw)/2), cy, tipTextSize*1.5, tipText, c.Theme.Muted)
	}
}

func roleColor(r hclient.Role) (color.RGBA, bool) { return people.ParseColor(r.Color) }
