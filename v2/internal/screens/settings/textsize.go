package settings

import (
	"strconv"

	"harmony/v2/internal/ui/widget"
)

const (
	textMin     = 80
	textMax     = 200
	textStep    = 5
	textDefault = 100
)

// textSize is the card that sets how big the type is, apart from the interface size.
type textSize struct {
	d      *Dialog
	slider widget.Slider
}

func newTextSize(d *Dialog) *textSize {
	t := &textSize{d: d}
	t.slider = widget.Slider{Min: textMin, Max: textMax, Step: textStep, Value: d.Settings.TextScale}
	t.slider.OnChange = func(int) { d.invalidate() }
	t.slider.OnCommit = t.set
	return t
}

func (t *textSize) set(percent int) {
	percent = min(max(percent, textMin), textMax)
	t.slider.Value = percent
	t.d.Settings.TextScale = percent
	t.d.apply()
}

func (t *textSize) card(c *widget.Context) widget.Component {
	return &widget.SettingCard{
		Title: c.T("settings.appearance.text_size"),
		Tools: &widget.Row{Gap: toolsGap, Items: []widget.RowItem{
			widget.Fixed(widget.ValuePill{Content: strconv.Itoa(t.slider.Value) + "%"}),
			widget.Fixed(&widget.Button{Label: c.T("scale_reset.reset"), Variant: widget.Ghost, Small: true, OnClick: func() { t.set(textDefault) }}),
		}},
		Children: []widget.Component{
			widget.SettingNote{Content: c.T("settings.appearance.text_size_note")},
			&widget.Row{Gap: scaleGap, Items: []widget.RowItem{
				widget.Fixed(widget.StepButton{OnClick: func() { t.set(t.slider.Value - textStep) }}),
				widget.Grow(&t.slider),
				widget.Fixed(widget.StepButton{Plus: true, OnClick: func() { t.set(t.slider.Value + textStep) }}),
			}},
		},
	}
}
