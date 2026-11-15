package settings

import "harmony/v2/internal/ui/widget"

// note is the line a card says what happened in.
type note struct {
	text   string
	failed bool
}

func (n *note) set(text string, failed bool) { n.text, n.failed = text, failed }

// component is the note, or an empty line that keeps the note above it its bottom margin, as Electron's empty status does.
func (n *note) component() []widget.Component {
	if n.text == "" {
		return []widget.Component{widget.Spacer{}}
	}
	return []widget.Component{widget.SettingNote{Content: n.text, Error: n.failed}}
}

// notes are what each card of the page has to say, by card.
type notes struct{ picture, banner, name, font, color, sound note }
