package channels

import (
	"strconv"

	"harmony/v2/internal/music"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	musicPopWidth        = 512
	musicPopSideGap      = 32
	musicPopMaxHeight    = 640
	musicPopViewportGap  = 16
	musicPopPad          = 11.2
	musicPopRoomyPad     = 9.6
	musicPopSection      = 8
	musicPopHeadH        = 31.7
	musicPopCloseW       = 43.7
	musicPopTitleSize    = 16
	musicPopTitleLine    = 24
	musicPopFindGap      = 6.4
	musicResultsMaxH     = 176
	musicResultsPad      = 4.8
	musicResultsRadius   = 8
	musicResultsFill     = 0.05
	musicNowPad          = 8
	musicNowRadius       = 8
	musicNowFill         = 0.06
	musicNowCover        = 51.2
	musicNowGap          = 9.6
	musicNowSpace        = 5.6
	musicNowLine         = 21
	musicNowTimeSize     = 12.48
	musicNowTimeLine     = 18.72
	musicNowTimeAlpha    = 0.75
	musicNowSeekW        = 130
	musicNowSeekH        = 18
	musicDeckButtonW     = 35.7
	musicDeckButtonH     = 30
	musicDeckGap         = 6.4
	musicQueueHeadH      = 33.2
	musicEmptyPad        = 8
	musicEmptyLine       = 21
	musicPopFrameFill    = 0.14
	musicDefaultDuration = "--:--"
)

var musicNone = &music.State{}

// musicPopLayout is how tall each part of the panel is for this frame.
type musicPopLayout struct {
	width                                  float32
	find, note, results, now, qhead, queue float32
	empty                                  float32
	total                                  float32
}

func (u *musicUI) layoutPop(c *widget.Context, width, room float32, note string) musicPopLayout {
	l := musicPopLayout{width: width}
	parts := 1
	total := float32(musicPopHeadH)
	section := func(h float32) {
		if h > 0 {
			total += musicPopSection + h
			parts++
		}
	}
	if u.may {
		l.find = u.input.Measure(c, width).H
		section(l.find)
	}
	if note != "" {
		l.note = widget.Banner{Kind: widget.ErrorBanner, Content: note}.Measure(c, width).H
		section(l.note)
	}
	if len(u.results.rows) > 0 {
		natural := 2*musicResultsPad + u.results.Measure(c, width-2*musicResultsPad).H
		l.results = min(natural, musicResultsMaxH)
		section(l.results)
	}
	if u.st.Live() {
		l.now = 2*musicNowPad + musicNowCover + musicNowSpace + musicNowSeekH
		if u.may {
			l.now += musicNowSpace + musicDeckButtonH
		}
		section(l.now)
	}
	if len(u.st.Queue) > 0 {
		l.qhead = musicQueueHeadH
		section(l.qhead)
	}
	l.queue = max(musicMinimumQueueRows, float32(len(u.st.Queue))*musicQueueRowHeight)
	section(l.queue)
	if len(u.st.Queue) == 0 {
		l.empty = 2*musicEmptyPad + musicEmptyLine
		section(l.empty)
	}
	if over := total - room; over > 0 {
		cut := min(over, l.queue-musicMinimumQueueRows)
		l.queue -= cut
		total -= cut
		over -= cut
		if cut = min(over, l.results); cut > 0 {
			l.results -= cut
			total -= cut
		}
	}
	l.total = total
	return l
}

func (u *musicUI) showPop(c *widget.Context, s *Screen, anchor, trigger geom.Rect) {
	if !u.pop.IsOpen() {
		return
	}
	if u.st == nil {
		u.st = musicNone
	}
	frame := u.pop.Frame(c)
	outer := min(musicPopWidth, c.Viewport.W-musicPopSideGap)
	inner := outer - 2*(musicPopPad+c.Hairline())
	room := min(musicPopMaxHeight, c.Viewport.H-musicPopViewportGap) - 2*(musicPopPad+c.Hairline())
	note, busy := u.pendingNote()
	l := u.layoutPop(c, inner, room, note)
	trim := float32(musicPopPad - musicPopRoomyPad)
	content := geom.Size{W: outer - 2*frame, H: l.total + 2*trim}
	u.search.Label = c.T("music.search")
	u.search.Disabled = busy
	u.clear.Label = c.T("music.clear")
	u.frame = popFrame{ctx: c, layout: l, note: note, trim: trim}
	if u.body == nil {
		u.body = func(box geom.Rect) { u.drawPop(u.frame.ctx, box.InsetAll(u.frame.trim), u.frame.layout, u.frame.note) }
	}
	u.pop.Draw(c, anchor, trigger, content, u.body)
}

// popFrame is what the panel's body needs of the frame it is drawn in, kept so that drawing it allocates nothing.
type popFrame struct {
	ctx    *widget.Context
	layout musicPopLayout
	note   string
	trim   float32
}

func (u *musicUI) drawPop(c *widget.Context, r geom.Rect, l musicPopLayout, note string) {
	y := r.Y
	c.Paint.Text(c.T("music.title"), r.X, y+(musicPopHeadH-musicPopTitleLine)/2, musicPopTitleLine, musicBoldStyle(musicPopTitleSize), c.Theme.Text)
	u.close.Draw(c, geom.Rect{X: r.Right() - musicPopCloseW, Y: y, W: musicPopCloseW, H: musicPopHeadH})
	y += musicPopHeadH

	if l.find > 0 {
		y += musicPopSection
		size := u.search.Measure(c, 0)
		u.input.Placeholder = c.T("music.find_placeholder")
		u.input.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W - size.W - musicPopFindGap, H: l.find})
		u.search.Draw(c, geom.Rect{X: r.Right() - size.W, Y: y, W: size.W, H: l.find})
		y += l.find
	}
	if l.note > 0 {
		y += musicPopSection
		widget.Banner{Kind: widget.ErrorBanner, Content: note}.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: l.note})
		y += l.note
	}
	if l.results > 0 {
		y += musicPopSection
		box := geom.Rect{X: r.X, Y: y, W: r.W, H: l.results}
		c.Paint.Fill(box, musicResultsRadius, theme.WithAlpha(c.Theme.Tint, musicResultsFill))
		view := box.InsetAll(musicResultsPad)
		u.results.view = view
		u.resultS.Draw(c, view)
		y += l.results
	}
	if l.now > 0 {
		y += musicPopSection
		u.drawNow(c, geom.Rect{X: r.X, Y: y, W: r.W, H: l.now})
		y += l.now
	}
	if l.qhead > 0 {
		y += musicPopSection
		u.drawQueueHead(c, geom.Rect{X: r.X, Y: y, W: r.W, H: l.qhead})
		y += l.qhead
	}
	y += musicPopSection
	view := geom.Rect{X: r.X, Y: y, W: r.W, H: l.queue}
	u.queue.view = view
	if len(u.st.Queue) > 0 {
		u.queueS.Draw(c, view)
	}
	y += l.queue
	if l.empty > 0 {
		y += musicPopSection
		text := c.T("music.nothing_playing_listener")
		if u.may {
			text = c.T("music.nothing_playing")
		}
		w := c.Paint.TextWidth(text, musicSmallStyle(musicHeadTextSize))
		c.Paint.Text(text, r.X+(r.W-w)/2, y+musicEmptyPad, musicEmptyLine, musicSmallStyle(musicHeadTextSize), c.Theme.Muted)
	}
}

func (u *musicUI) drawNow(c *widget.Context, r geom.Rect) {
	st, track := u.st, u.st.Now()
	c.Paint.Fill(r, musicNowRadius, theme.WithAlpha(c.Theme.Tint, musicNowFill))
	in := r.InsetAll(musicNowPad)
	cover := widget.Cover{Hash: track.ThumbHash, Source: u.sess.Chat(), Size: musicNowCover, Under: musicRowUnder(c, musicNowFill)}
	cover.Draw(c, geom.Rect{X: in.X, Y: in.Y})

	at := min(u.sess.MusicPosition().Milliseconds(), max(track.DurationMs, 0))
	ratio := 0
	if track.DurationMs > 0 {
		ratio = int(at * 1000 / track.DurationMs)
	}
	if !u.seeking {
		u.seek.Value = ratio
	}
	shown := at
	if u.seeking && track.DurationMs > 0 {
		shown = int64(u.seek.Value) * track.DurationMs / 1000
	}
	total := musicDefaultDuration
	if track.DurationMs > 0 {
		total = musicClockText(track.DurationMs)
	}
	time := musicClockText(shown) + " / " + total
	style := musicSmallStyle(musicNowTimeSize)
	timeW := c.Paint.TextWidth(time, style)
	c.Paint.Text(time, in.Right()-timeW, in.Y+(musicNowCover-musicNowTimeLine)/2, musicNowTimeLine, style, theme.WithAlpha(c.Theme.Text, musicNowTimeAlpha))

	textX := in.X + musicNowCover + musicNowGap
	textW := in.Right() - timeW - musicNowGap - textX
	top := in.Y + (musicNowCover-2*musicNowLine)/2
	u.nowTitle.Content = track.Title
	if u.nowTitle.Content == "" {
		u.nowTitle.Content = c.T("music.untitled")
	}
	u.nowArtist.Content = track.Artist
	if st.Status == music.Loading {
		u.nowArtist.Content = c.T("music.loading")
	}
	u.nowTitle.Draw(c, geom.Rect{X: textX, Y: top, W: textW, H: musicNowLine})
	u.nowArtist.Draw(c, geom.Rect{X: textX, Y: top + musicNowLine, W: textW, H: musicNowLine})

	y := in.Y + musicNowCover + musicNowSpace
	seek := geom.Rect{X: in.X, Y: y, W: musicNowSeekW, H: musicNowSeekH}
	if u.may {
		u.seek.Draw(c, seek)
	} else {
		c.Frozen(func() { u.seek.Draw(c, seek) })
	}
	y += musicNowSeekH + musicNowSpace
	if !u.may {
		return
	}
	u.deck.show(st)
	buttons := u.deck.buttons()
	row := float32(len(buttons))*musicDeckButtonW + float32(len(buttons)-1)*musicDeckGap
	x := in.X + (in.W-row)/2
	for i, b := range buttons {
		b.Draw(c, geom.Rect{X: x + float32(i)*(musicDeckButtonW+musicDeckGap), Y: y, W: musicDeckButtonW, H: musicDeckButtonH})
	}
}

func (u *musicUI) drawQueueHead(c *widget.Context, r geom.Rect) {
	count := len(u.st.Queue)
	text := c.Strings.Plural("music.queue_count", count, "count", strconv.Itoa(count))
	c.Paint.Text(text, r.X, r.Y+(r.H-musicHeadTextLine)/2, musicHeadTextLine, musicSmallStyle(musicHeadTextSize), c.Theme.Muted)
	if u.may {
		size := u.clear.Measure(c, 0)
		u.clear.Draw(c, geom.Rect{X: r.Right() - size.W, Y: r.Y + (r.H-size.H)/2, W: size.W, H: size.H})
	}
}
