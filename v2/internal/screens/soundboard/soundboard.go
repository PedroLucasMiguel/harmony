// Package soundboard is the popover over the voice panel's soundboard button: the server's clips to play for the channel, and their volume.
package soundboard

import (
	"strings"

	"harmony/v2/internal/app"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/hotkey"
	"harmony/v2/internal/store"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

const (
	panelWidth    = 480
	panelMaxH     = 416
	panelMaxShare = 0.7
	panelSideGap  = 32
	headGap       = 6.4
	headPad       = 8
	gridGap       = 6.4
	gridMinCell   = 136
	volumeSlot    = 128
	volumeBleed   = 8
	volumeMax     = 350
	emptyTop      = 12.8
	emptyBottom   = 3.2
	emptySize     = 13.6
	emptyLine     = emptySize * 1.5
)

// Board is the popover; the screen that owns the soundboard button draws it each frame.
type Board struct {
	Session  *app.Session
	Settings *store.Settings
	OnError  func(error)
	// Keys, when set, lets each clip have a hotkey (right-click a clip).
	Keys Hotkeys

	pop    widget.Popover
	search widget.TextField
	mute   widget.TinyButton
	volume widget.VolumeRow
	stop   widget.Button
	add    widget.Button
	head   widget.Row
	grid   widget.Grid
	list   widget.Scroll
	empty  widget.Text
	prompt widget.Prompt
	menu   widget.ContextMenu

	ready  bool
	stale  bool
	admin  bool
	clips  []hclient.Clip
	filter string
	body   func(content geom.Rect)
	headH  float32
	listH  float32
	ctx    *widget.Context
}

func (b *Board) IsOpen() bool { return b.pop.IsOpen() }

func (b *Board) Toggle() {
	if b.pop.IsOpen() {
		b.pop.Close()
		return
	}
	b.init()
	b.search.Value = ""
	b.search.RequestFocus()
	b.volume.Reset()
	b.volume.Value = b.Settings.SoundpadVolume
	b.stale = true
	b.pop.Open()
}

func (b *Board) Close() { b.pop.Close() }

func (b *Board) init() {
	if b.ready {
		return
	}
	b.ready = true
	b.pop.Roomy = true
	b.pop.Keep = b.menu.IsOpen
	b.search.Search = true
	b.mute = widget.TinyButton{OnClick: b.toggleMute}
	b.volume.Max = volumeMax
	b.volume.OnChange = b.setVolume
	b.volume.OnSettle = func(int) { b.Settings.Save() }
	b.stop = widget.Button{Variant: widget.Ghost, Small: true, OnClick: func() { b.run(b.Session.StopClips) }}
	b.add = widget.Button{Variant: widget.Ghost, Small: true, OnClick: b.askForFile}
	b.grid = widget.Grid{MinCell: gridMinCell, Gap: gridGap}
	b.list.Child = &b.grid
	b.empty = widget.Text{Style: paint.TextStyle{Size: emptySize, Weight: paint.Regular}, Tone: widget.ToneMuted, LineHeight: emptyLine}
	b.body = b.drawBody
}

func (b *Board) setVolume(percent int) {
	b.Settings.SoundpadVolume = percent
	b.Session.SetClipVolume(percent)
}

func (b *Board) toggleMute() {
	next := 0
	if b.Settings.SoundpadVolume == 0 {
		next = 100
	}
	b.volume.Value = next
	b.setVolume(next)
	b.Settings.Save()
}

func (b *Board) run(do func() error) {
	go func() {
		if err := do(); err != nil && b.OnError != nil {
			b.OnError(err)
		}
	}()
}

// Show draws the popover while it is open, above the button.
func (b *Board) Show(c *widget.Context, button geom.Rect) {
	if !b.pop.IsOpen() {
		return
	}
	b.sync(c)
	width := min(panelWidth, c.Viewport.W-panelSideGap) - 2*b.pop.Frame(c)
	b.headH = b.head.Measure(c, width).H
	rest := min(panelMaxH, panelMaxShare*c.Viewport.H) - 2*b.pop.Frame(c) - b.headH - headPad - c.Hairline() - headPad
	b.listH = b.gridHeight(c, width, rest)
	height := b.headH + headPad + c.Hairline() + headPad + b.listH
	b.ctx = c
	b.pop.Draw(c, button, button, geom.Size{W: width, H: height}, b.body)
	b.menu.Show(c)
}

// gridHeight is the room the clips take, or the empty message, within what the panel has left.
func (b *Board) gridHeight(c *widget.Context, width, room float32) float32 {
	if len(b.grid.Children) == 0 {
		return emptyTop + emptyLine + emptyBottom
	}
	return min(b.grid.Measure(c, width).H, room)
}

func (b *Board) drawBody(content geom.Rect) {
	c := b.ctx
	b.head.Draw(c, geom.Rect{X: content.X, Y: content.Y, W: content.W, H: b.headH})
	y := content.Y + b.headH + headPad
	c.Paint.Fill(geom.Rect{X: content.X, Y: y, W: content.W, H: c.Hairline()}, 0, c.Theme.Border)
	y += c.Hairline() + headPad
	if len(b.grid.Children) == 0 {
		width := b.empty.Measure(c, content.W).W
		b.empty.Draw(c, geom.Rect{X: content.X + (content.W-width)/2, Y: y + emptyTop, W: width, H: emptyLine})
		return
	}
	b.list.Draw(c, geom.Rect{X: content.X, Y: y, W: content.W, H: b.listH})
}

// sync brings the widgets up to date with the session, the settings and what is typed.
func (b *Board) sync(c *widget.Context) {
	b.search.Placeholder = c.T("soundpad.find_the_perfect_sound")
	b.stop.Label = c.T("soundpad.stop")
	b.add.Label = c.T("soundpad_add.add")
	b.mute.Icon = "speaker-high"
	if b.Settings.SoundpadVolume == 0 {
		b.mute.Icon = "speaker-x"
	}
	if admin := b.Session.IsAdmin(); admin != b.admin || b.head.Items == nil {
		b.admin, b.stale = admin, true
		b.buildHead()
	}
	clips, filter := b.Session.Clips(), strings.ToLower(strings.TrimSpace(b.search.Value))
	if b.stale || len(clips) != len(b.clips) || (len(clips) > 0 && &clips[0] != &b.clips[0]) || filter != b.filter {
		b.clips, b.filter, b.stale = clips, filter, false
		b.buildTiles(c)
	}
}

func (b *Board) buildHead() {
	b.head = widget.Row{Gap: headGap, Items: []widget.RowItem{
		widget.Grow(&b.search), widget.Fixed(&b.mute), widget.Fixed(volumeBox{row: &b.volume}),
	}}
	if b.admin {
		b.head.Items = append(b.head.Items, widget.Fixed(&b.stop), widget.Fixed(&b.add))
	}
}

func (b *Board) buildTiles(c *widget.Context) {
	b.grid.Children = b.grid.Children[:0]
	for index, clip := range b.clips {
		if b.filter != "" && !strings.Contains(strings.ToLower(clip.Name), b.filter) {
			continue
		}
		tile := &widget.ClipTile{Emoji: clip.Emoji, Name: clip.Name}
		if b.Keys != nil {
			clip := clip
			tile.Key = hotkey.Format(b.Keys.Binding(clipAction(clip)))
			tile.OnMenu = func(x, y float32) { b.openMenu(clip, x, y) }
		}
		if b.admin {
			tile.Tools = b.tools(clip, index, len(b.clips))
		}
		id := clip.ID
		tile.OnClick = func() { b.run(func() error { return b.Session.PlayClip(id) }) }
		b.grid.Children = append(b.grid.Children, tile)
	}
	switch {
	case len(b.clips) == 0 && b.admin:
		b.empty.Content = c.T("app.no_clips_yet_add_one")
	case len(b.clips) == 0:
		b.empty.Content = c.T("app.nobody_has_added_any_clips")
	default:
		b.empty.Content = c.T("app.nothing_matching", "value", b.search.Value)
	}
}

// volumeBox is the volume row at the width the soundboard head gives it: its own side padding hangs outside the slot.
type volumeBox struct{ row *widget.VolumeRow }

func (v volumeBox) Measure(c *widget.Context, _ float32) geom.Size {
	return geom.Size{W: volumeSlot, H: v.row.Measure(c, 0).H}
}

func (v volumeBox) Draw(c *widget.Context, r geom.Rect) {
	v.row.Draw(c, geom.Rect{X: r.X - volumeBleed, Y: r.Y, W: r.W + 2*volumeBleed, H: r.H})
}
