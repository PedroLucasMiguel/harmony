package settings

import (
	"image/color"
	"strconv"

	"harmony/v2/internal/i18n"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	zoomMin     = 70
	zoomMax     = 180
	zoomStep    = 5
	zoomDefault = 115
	toolsGap    = 8
	scaleGap    = 12
	swatchMin   = 88
	swatchGap   = 6.4
	swatchTop   = 0.6
)

type appearance struct {
	d        *Dialog
	language widget.Dropdown
	zoom     widget.Slider
	links    widget.Switch
	dmLinks  widget.Switch
	text     *textSize
	custom   *customEditor
}

func newAppearance(d *Dialog) *appearance {
	a := &appearance{d: d}
	a.language.OnChange = func(code string) {
		d.Settings.Language = code
		d.apply()
	}
	a.zoom = widget.Slider{Min: zoomMin, Max: zoomMax, Step: zoomStep, Value: d.Settings.UIScale}
	a.zoom.OnChange = func(int) { d.invalidate() }
	a.zoom.OnCommit = a.setZoom
	a.links.On = d.Settings.LinkPreviews
	a.links.OnChange = func(on bool) { d.Settings.LinkPreviews = on; d.save() }
	a.dmLinks.On = d.Settings.DMLinkPreviews
	a.dmLinks.OnChange = func(on bool) { d.Settings.DMLinkPreviews = on; d.save() }
	a.text, a.custom = newTextSize(d), newCustomEditor(d)
	return a
}

func (a *appearance) icon() string                   { return "eye" }
func (a *appearance) label(c *widget.Context) string { return c.T("settings.appearance") }

func (a *appearance) setZoom(percent int) {
	percent = min(max(percent, zoomMin), zoomMax)
	a.zoom.Value = percent
	a.d.Settings.UIScale = percent
	a.d.apply()
}

func (a *appearance) build(c *widget.Context) widget.Component {
	a.language.Options = languageOptions(c)
	a.language.Value = a.d.Settings.Language
	return widget.Col(0,
		widget.PageTitle(c.T("settings.appearance.appearance")),
		&widget.SettingCard{
			Title:    c.T("settings.language.title"),
			Children: []widget.Component{&a.language, widget.SettingNote{Content: c.T("settings.language.note")}},
		},
		&widget.SettingCard{
			Title: c.T("settings.appearance.colour_palette"),
			Children: []widget.Component{
				widget.SettingNote{Content: c.T("settings.appearance.yours_alone_nothing_is")},
				widget.Padded{Top: swatchTop, Child: a.swatches(c)},
				a.custom.editor(c),
			},
		},
		&widget.SettingCard{
			Title: c.T("settings.appearance.interface_size"),
			Tools: &widget.Row{Gap: toolsGap, Items: []widget.RowItem{
				widget.Fixed(widget.ValuePill{Content: strconv.Itoa(a.zoom.Value) + "%"}),
				widget.Fixed(&widget.Button{Label: c.T("scale_reset.reset"), Variant: widget.Ghost, Small: true, OnClick: func() { a.setZoom(zoomDefault) }}),
			}},
			Children: []widget.Component{
				widget.SettingNote{Content: c.T("settings.appearance.everything_at_once_the")},
				&widget.Row{Gap: scaleGap, Items: []widget.RowItem{
					widget.Fixed(widget.StepButton{OnClick: func() { a.setZoom(a.zoom.Value - zoomStep) }}),
					widget.Grow(&a.zoom),
					widget.Fixed(widget.StepButton{Plus: true, OnClick: func() { a.setZoom(a.zoom.Value + zoomStep) }}),
				}},
			},
		},
		a.text.card(c),
		&widget.SettingCard{Children: []widget.Component{
			widget.ToggleRow{Title: c.T("settings.links.title"), Hint: c.T("settings.links.note"), Switch: &a.links},
		}},
		&widget.SettingCard{Children: []widget.Component{
			widget.ToggleRow{Title: c.T("settings.dm_links.title"), Hint: c.T("settings.dm_links.note"), Switch: &a.dmLinks},
		}},
	)
}

func (a *appearance) swatches(c *widget.Context) widget.Component {
	grid := &widget.Grid{MinCell: swatchMin, Gap: swatchGap}
	for _, name := range theme.Names {
		p := theme.ByName(name)
		grid.Children = append(grid.Children, widget.Swatch{
			Label:   c.T("theme." + name),
			Bands:   [3]color.RGBA{p.Bg, p.Surface2, p.Accent},
			On:      a.d.Settings.Theme == name,
			OnClick: func() { a.d.Settings.Theme = name; a.d.apply() },
		})
	}
	grid.Children = append(grid.Children, a.custom.swatch(c))
	return grid
}

func languageOptions(c *widget.Context) []widget.Option {
	languages := i18n.Languages()
	options := []widget.Option{{Value: "auto", Label: c.T("settings.language.auto", "language", languageName(languages, i18n.Resolve("auto", i18n.SystemLanguages())))}}
	for _, l := range languages {
		options = append(options, widget.Option{Value: l.Code, Label: l.Name})
	}
	return options
}

func languageName(languages []i18n.Language, code string) string {
	for _, l := range languages {
		if l.Code == code {
			return l.Name
		}
	}
	return code
}
