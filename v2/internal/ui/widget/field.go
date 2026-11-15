package widget

import "harmony/v2/internal/ui/paint"

const (
	fieldLabelSize    = 12
	fieldLabelSpacing = 0.4
	fieldLabelGap     = 6
)

func FieldLabel(content string) *Text {
	return &Text{
		Content: content, Upper: true, Tone: ToneMuted,
		Style:      paint.TextStyle{Size: fieldLabelSize, Weight: paint.Semibold, Spacing: fieldLabelSpacing},
		LineHeight: fieldLabelSize * 1.5,
	}
}

func Field(label string, control Component) *Column {
	return Col(fieldLabelGap, FieldLabel(label), control)
}

const (
	dialogLabelSize = 12.48
	dialogLabelGap  = 3.2
)

// DialogField is a field as it reads on a settings page: a smaller label, set closer to its control.
func DialogField(label string, control Component) *Column {
	title := FieldLabel(label)
	title.Style.Size, title.LineHeight = dialogLabelSize, dialogLabelSize*1.5
	return Col(dialogLabelGap, title, control)
}
