package soundboard

import (
	"path/filepath"
	"strings"

	"harmony/v2/internal/filedialog"
	"harmony/v2/internal/ui/widget"
)

const maxClipName = 32

// askForFile lets the person choose an audio file, then asks what to call it.
func (b *Board) askForFile() {
	c := b.ctx
	title := c.T("soundpad_add.add")
	go func() {
		if files := filedialog.Pick(title); len(files) > 0 {
			c.Post(func() { b.nameClip(files[0]) })
		}
	}()
}

func (b *Board) nameClip(path string) {
	c := b.ctx
	emoji := &widget.PromptField{Label: c.T("app.emoji")}
	name := &widget.PromptField{Label: c.T("app.name"), Required: true}
	name.Input.MaxLength = maxClipName
	name.Input.Value = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	if runes := []rune(name.Input.Value); len(runes) > maxClipName {
		name.Input.Value = string(runes[:maxClipName])
	}
	b.prompt = widget.Prompt{
		Title:    c.T("app.name_this_clip"),
		Text:     c.T("soundpad.emoji_hint"),
		Fields:   []*widget.PromptField{emoji, name},
		OK:       c.T("app.add"),
		Cancel:   c.T("app.cancel"),
		OnCancel: c.CloseModal,
		OnSubmit: func(values []string) {
			c.CloseModal()
			b.run(func() error {
				return b.Session.AddClip(path, strings.TrimSpace(values[1]), strings.TrimSpace(values[0]))
			})
		},
	}
	c.OpenModal(&b.prompt)
}
