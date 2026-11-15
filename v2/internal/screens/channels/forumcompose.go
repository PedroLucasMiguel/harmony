package channels

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/chat"
	"harmony/v2/internal/filedialog"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	composePadX      = 12.8
	composeTop       = 11.2
	composeBottom    = 8
	composeGap       = 12.8
	composeBelow     = 12.8
	composeTile      = 67.2
	composeHeadH     = 30
	composeBodyTop   = 4.8
	composeBodyMin   = 60
	composeIndent    = 33.6
	composeClose     = 24
	composeFootTop   = 8
	composeFootPad   = 6.4
	composePostH     = 40
	composePrevTop   = 9.6
	composePrevH     = 64
	composePrevMinW  = 64
	composePrevMaxW  = 144
	composePrevGap   = 8
	composeRemove    = 20.8
	composeTileIcon  = 25.6
	composeTileAlpha = 0.06
	composeTitleSize = 14
	composeTitleMax  = 200
	composeBodyMax   = 4000
	composeProblem   = 12.8
	composeEmoji     = 20
)

var composeProblemStyle = paint.TextStyle{Size: composeProblem, Weight: paint.Regular}

// composeCard is the card a post is started in: a title, the words, the files, and Post.
type composeCard struct {
	shown   bool
	title   widget.TextField
	body    widget.TextArea
	post    widget.Button
	files   []string
	busy    *chat.Creating
	problem string
	picking bool
	wired   bool
	emoji   geom.Rect
	box     geom.Rect

	closeFn   func()
	openEmoji func()
	pickEmoji func(string)
}

func (k *composeCard) close() {
	k.shown, k.files, k.busy, k.problem = false, nil, nil, ""
	k.title.SetValue("")
	k.body.Clear()
}

// open shows the card, with a title already written when a search found no post to go to.
func (k *composeCard) open(s *Screen, title string) {
	if !k.wired {
		k.wired = true
		k.title.Bare, k.title.Style, k.title.MaxLength = true, paint.TextStyle{Size: composeTitleSize, Weight: paint.Regular}, composeTitleMax
		k.title.OnEnter = k.body.RequestFocus
		k.body.MaxLength = composeBodyMax
		k.body.OnSubmit = func() {
			if rl.IsKeyDown(rl.KeyLeftControl) || rl.IsKeyDown(rl.KeyRightControl) || rl.IsKeyDown(rl.KeyLeftSuper) || rl.IsKeyDown(rl.KeyRightSuper) {
				s.sendPost()
				return
			}
			k.body.Insert("\n")
		}
		k.closeFn = k.close
		k.openEmoji = func() { s.openPicker(k.emoji, k.pickEmoji) }
		k.pickEmoji = func(v string) {
			s.chat.picker.Close()
			k.body.Insert(v)
			k.body.RequestFocus()
			s.rememberEmoji(v)
		}
		k.post = widget.Button{Icon: "chats-teardrop", IconSize: 16.4, IconGap: 6.4, Variant: widget.Primary, OnClick: s.sendPost}
	}
	if k.shown {
		k.title.RequestFocus()
		return
	}
	k.shown = true
	k.title.SetValue(title)
	if title != "" {
		k.body.RequestFocus()
	} else {
		k.title.RequestFocus()
	}
}

func (k *composeCard) valid() bool {
	return strings.TrimSpace(k.title.Value) != "" && (strings.TrimSpace(k.body.Value()) != "" || len(k.files) > 0)
}

func (k *composeCard) add(paths []string, c *widget.Context) {
	k.problem = ""
	for _, p := range paths {
		if info, err := os.Stat(p); err != nil || info.IsDir() {
			continue
		}
		if len(k.files) >= chat.MaxPostFiles {
			k.problem = c.T("forum.too_many_files", "count", strconv.Itoa(chat.MaxPostFiles))
			break
		}
		k.files = append(k.files, p)
	}
}

func (s *Screen) sendPost() {
	f := &s.forum
	k := &f.compose
	if k.busy != nil || !k.valid() {
		return
	}
	k.problem = ""
	k.busy = s.Session.Chat().CreatePost(f.channel, strings.TrimSpace(k.title.Value), strings.TrimSpace(k.body.Value()), k.files)
}

func (s *Screen) pickPostFiles(c *widget.Context) {
	k := &s.forum.compose
	if k.picking {
		return
	}
	k.picking = true
	go func() {
		files := filedialog.Pick(c.T("forum.add_media"))
		c.Post(func() {
			k.picking = false
			k.add(files, c)
		})
	}()
}

func (k *composeCard) previewWidth(c *widget.Context, path string) float32 {
	if isImagePath(path) {
		return composePrevMinW
	}
	return min(max(c.Paint.TextWidth(filepath.Base(path), attachNameStyle)+16, composePrevMinW), composePrevMaxW)
}

var attachNameStyle = paint.TextStyle{Size: 12, Weight: paint.Regular}

func isImagePath(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp":
		return true
	}
	return false
}

// previewRows is how many rows the files take, wrapped into the width.
func (k *composeCard) previewRows(c *widget.Context, width float32) int {
	if len(k.files) == 0 {
		return 0
	}
	rows, x := 1, float32(0)
	for _, p := range k.files {
		w := k.previewWidth(c, p)
		if x > 0 && x+w > width {
			rows++
			x = 0
		}
		x += w + composePrevGap
	}
	return rows
}

// draw paints the card at the top of r and returns the room it takes, with the gap below it.
func (k *composeCard) draw(c *widget.Context, s *Screen, r geom.Rect) float32 {
	if !k.shown {
		return 0
	}
	k.settle(c, s)
	edge := c.Hairline()
	inner := geom.Rect{X: r.X + edge + composePadX, Y: r.Y + edge + composeTop, W: r.W - 2*(edge+composePadX)}
	wordsW := inner.W - composeTile - composeGap
	bodyH := max(float32(composeBodyMin), k.body.Measure(c, wordsW-composeIndent).H)
	gridH := max(composeHeadH+composeBodyTop+bodyH, composeTile)
	rows := k.previewRows(c, inner.W-composeIndent)
	prevH := float32(0)
	if rows > 0 {
		prevH = composePrevTop + float32(rows)*composePrevH + float32(rows-1)*composePrevGap
	}
	footH := composeFootTop + edge + composeFootPad + composePostH
	h := 2*edge + composeTop + gridH + prevH + footH + composeBottom
	card := geom.Rect{X: r.X, Y: r.Y, W: r.W, H: h}
	k.box = card

	focused := k.title.Focused(c) || k.body.Focused(c)
	border := c.Theme.Border
	if focused {
		border = c.Theme.Accent
	}
	c.Paint.Fill(card, postRadius, c.Theme.Surface2)
	c.Paint.Stroke(card, postRadius, edge, border)

	s.composerButton(c, geom.Rect{X: inner.X, Y: inner.Y + (composeHeadH-composeClose)/2 + 2.8, W: composeClose, H: composeClose}, "x", 16, c.Theme.Muted, k.closeFn)
	k.title.Placeholder = c.T("forum.title_placeholder")
	k.title.Draw(c, geom.Rect{X: inner.X + composeIndent - 1.6, Y: inner.Y + (composeHeadH-composeTitleSize*1.5)/2 - 1, W: wordsW - composeIndent, H: composeTitleSize * 1.5})
	k.body.Placeholder = c.T("forum.message_placeholder")
	k.body.Draw(c, geom.Rect{X: inner.X + composeIndent, Y: inner.Y + composeHeadH + composeBodyTop, W: wordsW - composeIndent, H: bodyH})
	k.drawTile(c, s, geom.Rect{X: inner.Right() - composeTile, Y: inner.Y, W: composeTile, H: composeTile})
	y := inner.Y + gridH
	if rows > 0 {
		k.drawPreviews(c, s, geom.Rect{X: inner.X + composeIndent, Y: y + composePrevTop, W: inner.W - composeIndent})
		y += prevH
	}
	k.drawFoot(c, s, geom.Rect{X: inner.X, Y: y + composeFootTop, W: inner.W, H: footH - composeFootTop})
	if c.EscapeBase() && focused {
		c.In.Escape = false
		k.close()
	}
	return h + composeBelow
}

// settle takes in the end of a post being sent: the post opens, or what went wrong is said.
func (k *composeCard) settle(c *widget.Context, s *Screen) {
	if k.busy == nil || !k.busy.Done.Load() {
		return
	}
	op := k.busy
	k.busy = nil
	if err, _ := op.Err.Load().(error); err != nil {
		k.problem = err.Error()
		return
	}
	k.close()
	if id := int(op.Post.Load()); id != 0 {
		s.openPost(id)
	}
}

func (k *composeCard) drawTile(c *widget.Context, s *Screen, r geom.Rect) {
	hovered := c.Hovered(r)
	border, ink := c.Theme.Border, c.Theme.Muted
	if hovered {
		border, ink = c.Theme.BorderStrong, c.Theme.Text
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(r) {
			c.Claim()
			s.pickPostFiles(c)
		}
	}
	c.Paint.Fill(r, postRadius, theme.WithAlpha(c.Theme.Tint, composeTileAlpha))
	c.Paint.Stroke(r, postRadius, c.Hairline(), border)
	c.Paint.Icon("image-square", geom.Rect{X: r.X + (r.W-composeTileIcon)/2, Y: r.Y + (r.H-composeTileIcon)/2, W: composeTileIcon, H: composeTileIcon}, ink)
}

func (k *composeCard) drawPreviews(c *widget.Context, s *Screen, r geom.Rect) {
	x, y := r.X, r.Y
	for i := 0; i < len(k.files); i++ {
		path := k.files[i]
		w := k.previewWidth(c, path)
		if x > r.X && x+w > r.Right() {
			x, y = r.X, y+composePrevH+composePrevGap
		}
		cell := geom.Rect{X: x, Y: y, W: w, H: composePrevH}
		c.Paint.Fill(cell, 8, c.Theme.Bg)
		c.Paint.PushClip(cell)
		if isImagePath(path) {
			pic := c.Paint.Picture("file:"+path, func() ([]byte, error) { return os.ReadFile(path) })
			if _, _, ok := pic.Size(); ok {
				c.Paint.DrawPicture(pic, cell, 8, true, c.Theme.Surface2)
			}
		} else {
			name := filepath.Base(path)
			c.Paint.TextIn(cell.Inset(8, 0, 8, 0), name, cell.X+8, cell.Y+(cell.H-18)/2, 18, attachNameStyle, c.Theme.Text)
		}
		c.Paint.PopClip()
		c.Paint.Stroke(cell, 8, c.Hairline(), c.Theme.Border)
		rm := geom.Rect{X: cell.Right() - 2 - composeRemove, Y: cell.Y + 2, W: composeRemove, H: composeRemove}
		c.Paint.Circle(rm.X+rm.W/2, rm.Y+rm.H/2, rm.W/2, rl.NewColor(0, 0, 0, 166))
		c.Paint.Icon("x", geom.Rect{X: rm.X + 4.4, Y: rm.Y + 4.4, W: rm.W - 8.8, H: rm.H - 8.8}, rl.White)
		if c.Hovered(rm) {
			c.SetCursor(rl.MouseCursorPointingHand)
			if c.Clicked(rm) {
				c.Claim()
				k.files = append(k.files[:i], k.files[i+1:]...)
				i--
			}
		}
		x += w + composePrevGap
	}
}

func (k *composeCard) drawFoot(c *widget.Context, s *Screen, r geom.Rect) {
	edge := c.Hairline()
	c.Paint.Fill(geom.Rect{X: r.X, Y: r.Y, W: r.W, H: edge}, 0, c.Theme.Border)
	label := c.T("forum.post")
	if k.busy != nil {
		label = c.T("forum.posting")
	}
	k.post.Label = label
	k.post.Disabled = k.busy != nil || !k.valid()
	size := k.post.Measure(c, 0)
	btn := geom.Rect{X: r.Right() - size.W, Y: r.Y + edge + composeFootPad, W: size.W, H: size.H}
	k.post.Draw(c, btn)
	k.emoji = geom.Rect{X: r.X - 3.4, Y: btn.Bottom() - composeEmoji, W: 28, H: composeEmoji}
	s.composerButton(c, k.emoji, "smiley", composerIcon, c.Theme.Muted, k.openEmoji)
	if k.problem != "" {
		x := k.emoji.Right() + 8
		clip := geom.Rect{X: x, Y: btn.Y, W: max(0, btn.X-8-x), H: btn.H}
		c.Paint.TextIn(clip, k.problem, x, btn.Y+(btn.H-composeProblem*1.5)/2, composeProblem*1.5, composeProblemStyle, c.Theme.DangerSoft)
	}
}
