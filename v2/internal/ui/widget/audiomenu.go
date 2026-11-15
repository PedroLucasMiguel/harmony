package widget

import (
	"image/color"
	"strings"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	audioMinWidth     = 256
	audioMaxWidth     = 352
	audioListMax      = 224
	audioItemGap      = 1
	audioTitleSize    = 11.52
	audioTitleLine    = 17.28
	audioTitlePadTop  = 4
	audioTitlePadBot  = 2.4
	audioTitlePadX    = 8.8
	audioTitleSpacing = 0.23
	audioTitleAlpha   = 0.6
	audioRuleMarginY  = 4.8
	audioRuleMarginX  = 3.2
	audioItemPadX     = 8.8
	audioItemPadY     = 7.2
	audioItemGapX     = 9.6
	audioItemIcon     = 16.9
	audioItemSize     = 14.08
	audioItemLine     = 21.12
	audioItemRadius   = 8
	audioItemHover    = 0.16
	audioRadio        = 16
	audioRadioRing    = 2
	audioRadioDot     = 3.4
)

var (
	audioTitleStyle = paint.TextStyle{Size: audioTitleSize, Weight: paint.Semibold, Spacing: audioTitleSpacing}
	audioItemStyle  = paint.TextStyle{Size: audioItemSize, Weight: paint.Medium}
)

// AudioMenu is the popover behind the microphone and headphone buttons: which device, and how loud.
type AudioMenu struct {
	Icon          string
	DeviceTitle   string
	VolumeTitle   string
	SettingsLabel string
	Devices       []Option
	Selected      string
	Volume        VolumeRow
	OnPick        func(id string)
	OnSettings    func()

	pop  Popover
	list Scroll
	rows deviceRows
}

func (m *AudioMenu) IsOpen() bool { return m.pop.IsOpen() }

func (m *AudioMenu) Open() {
	m.Volume.Flush()
	m.pop.Open()
	m.Volume.Reset()
}

func (m *AudioMenu) Close() { m.pop.Close() }

// Show draws the menu while it is open, hung from anchor; a press on trigger is left to whatever toggles the menu.
func (m *AudioMenu) Show(c *Context, anchor, trigger geom.Rect) {
	if !m.pop.IsOpen() {
		m.Volume.Flush()
		return
	}
	m.rows.menu = m
	m.list.Child = &m.rows
	frame := m.pop.Frame(c)
	width := min(max(m.width(c), audioMinWidth), min(audioMaxWidth, c.Viewport.W-2*PopoverMargin())) - 2*frame
	listH := min(m.rows.Measure(c, width).H, audioListMax)
	titleH := float32(audioTitlePadTop + audioTitleLine + audioTitlePadBot)
	ruleH := 2*audioRuleMarginY + c.Hairline()
	settingsH := float32(audioItemLine + 2*audioItemPadY)
	height := titleH + listH + ruleH + titleH + m.Volume.Measure(c, width).H + ruleH + settingsH + 6*audioItemGap
	m.pop.Draw(c, anchor, trigger, geom.Size{W: width, H: height}, func(r geom.Rect) {
		y := r.Y
		y = m.drawTitle(c, r, y, m.DeviceTitle)
		m.rows.clip = geom.Rect{X: r.X, Y: y, W: r.W, H: listH}
		m.list.Draw(c, m.rows.clip)
		y += listH + audioItemGap
		y = m.drawRule(c, r, y)
		y = m.drawTitle(c, r, y, m.VolumeTitle)
		rowH := m.Volume.Measure(c, r.W).H
		m.Volume.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: rowH})
		y += rowH + audioItemGap
		y = m.drawRule(c, r, y)
		m.drawSettings(c, geom.Rect{X: r.X, Y: y, W: r.W, H: settingsH})
	})
}

func (m *AudioMenu) width(c *Context) float32 {
	widest := c.Paint.TextWidth(m.SettingsLabel, audioItemStyle)
	for _, d := range m.Devices {
		widest = max(widest, c.Paint.TextWidth(d.Label, audioItemStyle))
	}
	return widest + 2*audioItemPadX + audioItemIcon + 2*audioItemGapX + audioRadio + 2*m.pop.Frame(c)
}

func (m *AudioMenu) drawTitle(c *Context, r geom.Rect, y float32, title string) float32 {
	ink := theme.WithAlpha(c.Theme.Text, audioTitleAlpha)
	c.Paint.Text(strings.ToUpper(title), r.X+audioTitlePadX, y+audioTitlePadTop, audioTitleLine, audioTitleStyle, ink)
	return y + audioTitlePadTop + audioTitleLine + audioTitlePadBot + audioItemGap
}

func (m *AudioMenu) drawRule(c *Context, r geom.Rect, y float32) float32 {
	y += audioRuleMarginY
	c.Paint.Fill(geom.Rect{X: r.X + audioRuleMarginX, Y: y, W: r.W - 2*audioRuleMarginX, H: c.Hairline()}, 0, c.Theme.Border)
	return y + c.Hairline() + audioRuleMarginY + audioItemGap
}

func (m *AudioMenu) drawSettings(c *Context, r geom.Rect) {
	hovered := c.Hovered(r)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
		c.Paint.Fill(r, audioItemRadius, theme.WithAlpha(c.Theme.Accent, audioItemHover))
	}
	drawItemRow(c, r, "gear-six", m.SettingsLabel, hovered, c.Theme.Text)
	if hovered && c.In.Pressed {
		c.Claim()
		m.pop.Close()
		if m.OnSettings != nil {
			m.OnSettings()
		}
	}
}

func drawItemRow(c *Context, r geom.Rect, icon, label string, hovered bool, ink color.RGBA) {
	iconInk := c.Theme.Muted
	if hovered {
		iconInk = c.Theme.Accent
	}
	x := r.X + audioItemPadX
	c.Paint.Icon(icon, geom.Rect{X: x, Y: r.Y + (r.H-audioItemIcon)/2, W: audioItemIcon, H: audioItemIcon}, iconInk)
	c.Paint.Text(label, x+audioItemIcon+audioItemGapX, r.Y+audioItemPadY, audioItemLine, audioItemStyle, ink)
}

type deviceRows struct {
	menu *AudioMenu
	clip geom.Rect
}

func (d *deviceRows) Measure(_ *Context, maxWidth float32) geom.Size {
	n := float32(len(d.menu.Devices))
	rowH := float32(audioItemLine + 2*audioItemPadY)
	return geom.Size{W: maxWidth, H: n*rowH + max(n-1, 0)*audioItemGap}
}

func (d *deviceRows) Draw(c *Context, r geom.Rect) {
	m := d.menu
	rowH := float32(audioItemLine + 2*audioItemPadY)
	for i, device := range m.Devices {
		row := geom.Rect{X: r.X, Y: r.Y + float32(i)*(rowH+audioItemGap), W: r.W, H: rowH}
		chosen := device.Value == m.Selected
		hovered := c.Hovered(row.Intersect(d.clip))
		if hovered {
			c.SetCursor(rl.MouseCursorPointingHand)
			c.Paint.Fill(row, audioItemRadius, theme.WithAlpha(c.Theme.Accent, audioItemHover))
		}
		ink := c.Theme.Text
		nameRoom := geom.Rect{X: row.X, Y: row.Y, W: row.W - audioItemPadX - audioRadio - audioItemGapX, H: row.H}
		c.Paint.PushClip(nameRoom)
		drawItemRow(c, row, m.Icon, device.Label, hovered, ink)
		c.Paint.PopClip()
		drawRadio(c, geom.Rect{X: row.Right() - audioItemPadX - audioRadio, Y: row.Y + (row.H-audioRadio)/2, W: audioRadio, H: audioRadio}, chosen)
		if hovered && c.In.Pressed {
			c.Claim()
			m.Selected = device.Value
			if m.OnPick != nil {
				m.OnPick(device.Value)
			}
		}
	}
}

func drawRadio(c *Context, r geom.Rect, chosen bool) {
	ink := c.Theme.Muted
	if chosen {
		ink = c.Theme.Accent
	}
	cx, cy := r.X+r.W/2, r.Y+r.H/2
	c.Paint.Circle(cx, cy, audioRadio/2, ink)
	c.Paint.Circle(cx, cy, audioRadio/2-audioRadioRing, c.Theme.Surface)
	if chosen {
		c.Paint.Circle(cx, cy, audioRadioDot, ink)
	}
}
