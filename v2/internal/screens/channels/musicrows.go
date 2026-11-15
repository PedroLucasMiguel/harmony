package channels

import (
	"image/color"
	"strconv"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/music"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	musicRowPadX        = 5.6
	musicRowPadY        = 4
	musicRowGap         = 8
	musicRowRadius      = 8
	musicRowHoverFill   = 0.08
	musicRowCurrentFill = 0.12
	musicRowBarW        = 3
	musicRowFailedAlpha = 0.5
	musicListGap        = 3.2
	musicResultsHeadPad = 1.6
	musicResultsHeadBot = 4.8
	musicToolW          = 29.3
	musicToolH          = 30
	musicToolGap        = 1.6
	musicDragStart      = 4
	musicDropMark       = 2
	musicDraggedAlpha   = 0.4
	musicRowTextSize    = 11.84
	musicHeadTextSize   = 14
	musicHeadTextLine   = 21
)

// musicResultRow is one track found by a search or a link, with what can be done with it.
type musicResultRow struct {
	item   hclient.MusicItem
	title  widget.FitLine
	artist widget.FitLine
	length string
	next   widget.Button
	add    widget.Button
}

func (u *musicUI) newResultRow(item hclient.MusicItem) *musicResultRow {
	row := &musicResultRow{item: item, length: musicClockOrEmpty(item.DurationMs)}
	row.title = widget.FitLine{Content: item.Title, Style: musicBoldStyle(musicRowTitleSize), LineHeight: musicRowTitleLine}
	row.artist = widget.FitLine{Content: item.Artist, Style: musicSmallStyle(musicRowArtistSize), Tone: widget.ToneMuted, LineHeight: musicRowArtistLine}
	row.next = widget.Button{Variant: widget.Ghost, Small: true, OnClick: func() { u.add([]hclient.MusicItem{item}, true, false) }}
	row.add = widget.Button{Variant: widget.Primary, OnClick: func() { u.add([]hclient.MusicItem{item}, false, false) }}
	return row
}

func musicClockOrEmpty(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return musicClockText(ms)
}

func (row *musicResultRow) height(c *widget.Context) float32 {
	return 2*musicRowPadY + max(row.add.Measure(c, 0).H, musicTrackTextHeight)
}

func musicRowUnder(c *widget.Context, fill float32) color.RGBA {
	return theme.Mix(c.Theme.Surface2, c.Theme.Tint, fill)
}

func (row *musicResultRow) Draw(c *widget.Context, u *musicUI, r geom.Rect) {
	row.next.Label, row.add.Label = c.T("music.play_next"), c.T("music.add")
	if c.Hovered(r) {
		c.Paint.Fill(r, musicRowRadius, theme.WithAlpha(c.Theme.Tint, musicRowHoverFill))
	}
	cover := widget.Cover{Hash: row.item.ThumbHash, Source: u.sess.Chat(), Size: musicStripCover, Under: musicRowUnder(c, musicRowHoverFill)}
	cover.Draw(c, geom.Rect{X: r.X + musicRowPadX, Y: r.Y + (r.H-musicStripCover)/2})
	right := r.Right() - musicRowPadX
	for _, b := range []*widget.Button{&row.add, &row.next} {
		size := b.Measure(c, 0)
		b.Draw(c, geom.Rect{X: right - size.W, Y: r.Y + (r.H-size.H)/2, W: size.W, H: size.H})
		right -= size.W + musicRowGap
	}
	if row.length != "" {
		w := c.Paint.TextWidth(row.length, musicSmallStyle(musicRowTextSize))
		c.Paint.Text(row.length, right-w, r.Y+(r.H-musicRowArtistLine)/2, musicRowArtistLine, musicSmallStyle(musicRowTextSize), c.Theme.Muted)
		right -= w + musicRowGap
	}
	x := r.X + musicRowPadX + musicStripCover + musicRowGap
	top := r.Y + (r.H-musicTrackTextHeight)/2
	row.title.Draw(c, geom.Rect{X: x, Y: top, W: right - x, H: musicRowTitleLine})
	row.artist.Draw(c, geom.Rect{X: x, Y: top + musicRowTitleLine, W: right - x, H: musicRowArtistLine})
}

// musicResultList is what a search found, in the scrolling box under the search field.
type musicResultList struct {
	owner  *musicUI
	rows   []*musicResultRow
	all    widget.Button
	list   widget.Button
	count  string
	view   geom.Rect
	offset float32
}

func (l *musicResultList) rebuild(u *musicUI) {
	l.rows = l.rows[:0]
	for _, item := range u.found.Items {
		l.rows = append(l.rows, u.newResultRow(item))
	}
	items := u.found.Items
	l.all = widget.Button{Variant: widget.Primary, OnClick: func() { u.add(items, false, true) }}
	l.list = widget.Button{Variant: widget.Ghost, Small: true, OnClick: func() {
		u.input.Value = "https://www.youtube.com/playlist?list=" + u.found.Playlist
		u.find()
	}}
}

func (l *musicResultList) hasHead() bool {
	return len(l.rows) > 1 || l.owner.found.Playlist != ""
}

func (l *musicResultList) headHeight(c *widget.Context) float32 {
	return musicResultsHeadPad + l.all.Measure(c, 0).H + musicResultsHeadBot
}

func (l *musicResultList) Measure(c *widget.Context, maxWidth float32) geom.Size {
	h := float32(0)
	if l.hasHead() {
		h += l.headHeight(c)
		if len(l.rows) > 0 {
			h += musicListGap
		}
	}
	for i, row := range l.rows {
		if i > 0 {
			h += musicListGap
		}
		h += row.height(c)
	}
	return geom.Size{W: maxWidth, H: h}
}

func (l *musicResultList) Draw(c *widget.Context, r geom.Rect) {
	u := l.owner
	y := r.Y
	if l.hasHead() {
		h := l.headHeight(c)
		l.all.Label = c.T("music.add_all", "count", strconv.Itoa(len(l.rows)))
		l.list.Label = c.T("music.whole_playlist")
		right := r.Right() - 3.2
		if len(l.rows) > 1 {
			size := l.all.Measure(c, 0)
			l.all.Draw(c, geom.Rect{X: right - size.W, Y: y + musicResultsHeadPad, W: size.W, H: size.H})
			right -= size.W + 6.4
			c.Paint.Text(c.Strings.Plural("music.results", len(l.rows), "count", strconv.Itoa(len(l.rows))), r.X+3.2, y+musicResultsHeadPad+(size.H-musicHeadTextLine)/2, musicHeadTextLine, musicSmallStyle(musicHeadTextSize), c.Theme.Muted)
		}
		if u.found.Playlist != "" {
			size := l.list.Measure(c, 0)
			l.list.Draw(c, geom.Rect{X: right - size.W, Y: y + musicResultsHeadPad + (l.all.Measure(c, 0).H-size.H)/2, W: size.W, H: size.H})
		}
		y += h + musicListGap
	}
	for _, row := range l.rows {
		h := row.height(c)
		if y+h > l.view.Y && y < l.view.Bottom() {
			row.Draw(c, u, geom.Rect{X: r.X, Y: y, W: r.W, H: h})
		}
		y += h + musicListGap
	}
}

// musicQueueRow is one track of the queue.
type musicQueueRow struct {
	track  *music.Track
	title  widget.FitLine
	artist widget.FitLine
	by     string
	length string
	up     widget.PlateButton
	down   widget.PlateButton
	skip   widget.PlateButton
	remove widget.PlateButton
}

func (u *musicUI) newQueueRow() *musicQueueRow {
	row := &musicQueueRow{}
	row.title = widget.FitLine{Style: musicBoldStyle(musicRowTitleSize), LineHeight: musicRowTitleLine}
	row.artist = widget.FitLine{Style: musicSmallStyle(musicRowArtistSize), Tone: widget.ToneMuted, LineHeight: musicRowArtistLine}
	tool := func(icon string, run func()) widget.PlateButton {
		return widget.PlateButton{Icon: icon, Variant: widget.Ghost, Faint: true, OnClick: run}
	}
	row.up = tool("arrow-up", func() { u.ask("move", map[string]any{"id": row.track.ID, "index": u.queue.indexOf(row.track.ID) - 1}) })
	row.down = tool("arrow-down", func() { u.ask("move", map[string]any{"id": row.track.ID, "index": u.queue.indexOf(row.track.ID) + 1}) })
	row.skip = tool("skip-forward", func() { u.ask("next-up", map[string]any{"id": row.track.ID}) })
	row.remove = tool("x", func() { u.ask("remove", map[string]any{"id": row.track.ID}) })
	return row
}

func (row *musicQueueRow) set(c *widget.Context, track *music.Track) {
	if row.track != nil && row.track.ID == track.ID && row.track.Title == track.Title && row.track.Artist == track.Artist && row.track.Error == track.Error && row.track.AddedBy == track.AddedBy {
		row.track = track
		return
	}
	row.track = track
	row.title.Content = track.Title
	if row.title.Content == "" {
		row.title.Content = c.T("music.untitled")
	}
	row.artist.Content = track.Artist
	if track.Error != "" {
		unavailable := c.T("music.unavailable")
		if track.Artist != "" {
			unavailable = track.Artist + " · " + unavailable
		}
		row.artist.Content = unavailable
	}
	row.by = ""
	if track.AddedBy != "" {
		row.by = c.T("music.added_by", "name", track.AddedBy)
	}
	row.length = musicClockOrEmpty(track.DurationMs)
}

const musicQueueRowHeight = 2*musicRowPadY + musicTrackTextHeight

// musicQueueList is the queue as a column of rows that can be pressed to play and dragged to move.
type musicQueueList struct {
	owner   *musicUI
	rows    []*musicQueueRow
	built   *music.State
	view    geom.Rect
	pressed int
	active  bool
	pressY  float32
	drag    bool
	dropAt  int
	dropEnd bool
}

func (l *musicQueueList) indexOf(id string) int {
	for i, row := range l.rows {
		if row.track.ID == id {
			return i
		}
	}
	return -1
}

func (l *musicQueueList) Measure(c *widget.Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: float32(len(l.owner.st.Queue)) * musicQueueRowHeight}
}

func (l *musicQueueList) sync(c *widget.Context) {
	st := l.owner.st
	for len(l.rows) < len(st.Queue) {
		l.rows = append(l.rows, l.owner.newQueueRow())
	}
	l.rows = l.rows[:len(st.Queue)]
	for i := range st.Queue {
		l.rows[i].set(c, &st.Queue[i])
	}
	l.built = st
}

func (l *musicQueueList) Draw(c *widget.Context, r geom.Rect) {
	u := l.owner
	st := u.st
	if l.built != st {
		l.sync(c)
	}
	at := -1
	for i, row := range l.rows {
		if row.track.ID == st.Current {
			at = i
		}
	}
	movedFrom := -1
	if l.active && l.drag {
		movedFrom = l.pressed
	}
	l.dropAt = -1
	for i, row := range l.rows {
		rect := geom.Rect{X: r.X, Y: r.Y + float32(i)*musicQueueRowHeight, W: r.W, H: musicQueueRowHeight}
		if rect.Bottom() < l.view.Y || rect.Y > l.view.Bottom() {
			continue
		}
		l.drawRow(c, row, rect, i, at, movedFrom)
	}
	l.finishPress(c)
}

func (l *musicQueueList) drawRow(c *widget.Context, row *musicQueueRow, r geom.Rect, i, at, movedFrom int) {
	u := l.owner
	track := row.track
	hovered := u.may && c.Hovered(r) && c.Hovered(l.view)
	fill := float32(0)
	switch {
	case track.ID == u.st.Current:
		fill = musicRowCurrentFill
	case hovered:
		fill = musicRowHoverFill
	}
	dim := i == movedFrom
	if fill > 0 {
		c.Paint.Fill(r, musicRowRadius, theme.WithAlpha(c.Theme.Tint, fill))
	}
	if track.ID == u.st.Current {
		c.Paint.PushClip(geom.Rect{X: r.X, Y: r.Y, W: musicRowBarW, H: r.H})
		c.Paint.Fill(r, musicRowRadius, c.Theme.Accent)
		c.Paint.PopClip()
	}
	cover := widget.Cover{Hash: track.ThumbHash, Source: u.sess.Chat(), Size: musicStripCover, Under: musicRowUnder(c, fill)}
	cover.Draw(c, geom.Rect{X: r.X + musicRowPadX, Y: r.Y + (r.H-musicStripCover)/2})

	right := r.Right() - musicRowPadX
	tools := geom.Rect{X: right, Y: r.Y, H: r.H}
	if u.may {
		tools.W = 4*musicToolW + 3*musicToolGap
		tools.X = right - tools.W
		row.up.Disabled = i == 0
		row.down.Disabled = i == len(l.rows)-1
		row.skip.Disabled = track.ID == u.st.Current || i == at+1
		for k, b := range [4]*widget.PlateButton{&row.up, &row.down, &row.skip, &row.remove} {
			b.Draw(c, geom.Rect{X: tools.X + float32(k)*(musicToolW+musicToolGap), Y: r.Y + (r.H-musicToolH)/2, W: musicToolW, H: musicToolH})
		}
		right = tools.X - musicRowGap
	}
	if row.length != "" {
		w := c.Paint.TextWidth(row.length, musicSmallStyle(musicRowTextSize))
		c.Paint.Text(row.length, right-w, r.Y+(r.H-musicRowArtistLine)/2, musicRowArtistLine, musicSmallStyle(musicRowTextSize), c.Theme.Muted)
		right -= w + musicRowGap
	}
	if row.by != "" && c.Viewport.W >= narrowWidth {
		w := c.Paint.TextWidth(row.by, musicSmallStyle(musicRowTextSize))
		c.Paint.Text(row.by, right-w, r.Y+(r.H-musicRowArtistLine)/2, musicRowArtistLine, musicSmallStyle(musicRowTextSize), c.Theme.Muted)
		right -= w + musicRowGap
	}
	x := r.X + musicRowPadX + musicStripCover + musicRowGap
	row.title.Opacity, row.artist.Opacity = 0, 0
	if track.Error != "" || dim {
		row.title.Opacity, row.artist.Opacity = musicRowFailedAlpha, musicRowFailedAlpha
		if dim {
			row.title.Opacity, row.artist.Opacity = musicDraggedAlpha, musicDraggedAlpha
		}
	}
	top := r.Y + (r.H-musicTrackTextHeight)/2
	row.title.Draw(c, geom.Rect{X: x, Y: top, W: right - x, H: musicRowTitleLine})
	row.artist.Draw(c, geom.Rect{X: x, Y: top + musicRowTitleLine, W: right - x, H: musicRowArtistLine})

	if !u.may {
		return
	}
	if hovered && c.In.Pressed && !tools.Contains(c.In.MouseX, c.In.MouseY) && !l.active {
		l.active, l.pressed, l.pressY, l.drag = true, i, c.In.MouseY, false
	}
	if l.active && l.drag && c.Hovered(r) && i != l.pressed {
		before := c.In.MouseY < r.Y+r.H/2
		l.dropAt, l.dropEnd = i, !before
		edge := geom.Rect{X: r.X, Y: r.Y, W: r.W, H: musicDropMark}
		if !before {
			edge.Y = r.Bottom() - musicDropMark
		}
		c.Paint.Fill(edge, 0, c.Theme.Accent)
	}
}

// finishPress turns a press on a row into a play when it was a click, and into a move when the row was dragged.
func (l *musicQueueList) finishPress(c *widget.Context) {
	if !l.active {
		return
	}
	if c.In.Down && !l.drag && musicAbs32(c.In.MouseY-l.pressY) > musicDragStart {
		l.drag = true
	}
	if l.drag {
		c.SetCursor(rl.MouseCursorResizeNS)
	}
	if c.In.Down {
		return
	}
	u, from := l.owner, l.pressed
	l.active = false
	if from >= len(l.rows) {
		return
	}
	id := l.rows[from].track.ID
	switch {
	case !l.drag:
		u.ask("play", map[string]any{"id": id})
	case l.dropAt >= 0 && l.dropAt != from:
		to := l.dropAt
		if l.dropEnd {
			to++
		}
		if from < to {
			to--
		}
		if to != from {
			u.ask("move", map[string]any{"id": id, "index": to})
		}
	}
	l.drag = false
}

func musicAbs32(v float32) float32 {
	if v < 0 {
		return -v
	}
	return v
}
