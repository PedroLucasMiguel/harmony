package settings

import "harmony/v2/internal/ui/widget"

// feedback is the line under a control that says how it went.
type feedback struct {
	text   string
	failed bool
}

func (f *feedback) set(text string, failed bool) { f.text, f.failed = text, failed }

func (f *feedback) clear() { f.text, f.failed = "", false }

// note is the line as a component, or nothing while there is nothing to say.
func (f *feedback) note() []widget.Component {
	if f.text == "" {
		return nil
	}
	return []widget.Component{widget.SettingNote{Content: f.text, Error: f.failed}}
}
