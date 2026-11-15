package soundboard

import (
	"strings"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/widget"
)

// tools are the buttons an admin gets over a clip: move it left or right, rename it, delete it.
func (b *Board) tools(clip hclient.Clip, index, count int) []widget.ClipTool {
	id := clip.ID
	return []widget.ClipTool{
		{Icon: "caret-left", Disabled: index == 0, OnClick: func() { b.run(func() error { return b.Session.MoveClip(id, -1) }) }},
		{Icon: "caret-right", Disabled: index == count-1, OnClick: func() { b.run(func() error { return b.Session.MoveClip(id, 1) }) }},
		{Icon: "pencil-simple", OnClick: func() { b.rename(clip) }},
		{Icon: "x", OnClick: func() { b.confirmDelete(clip) }},
	}
}

func (b *Board) rename(clip hclient.Clip) {
	c := b.ctx
	emoji := &widget.PromptField{Label: c.T("app.emoji")}
	emoji.Input.Value = clip.Emoji
	name := &widget.PromptField{Label: c.T("app.name"), Required: true}
	name.Input.MaxLength = maxClipName
	name.Input.Value = clip.Name
	b.prompt = widget.Prompt{
		Title:    c.T("app.rename", "name", clip.Name),
		Text:     c.T("soundpad.emoji_hint"),
		Fields:   []*widget.PromptField{emoji, name},
		OK:       c.T("app.save"),
		Cancel:   c.T("app.cancel"),
		OnCancel: c.CloseModal,
		OnSubmit: func(values []string) {
			c.CloseModal()
			b.run(func() error {
				return b.Session.RenameClip(clip.ID, strings.TrimSpace(values[1]), strings.TrimSpace(values[0]))
			})
		},
	}
	c.OpenModal(&b.prompt)
}

func (b *Board) confirmDelete(clip hclient.Clip) {
	c := b.ctx
	b.prompt = widget.Prompt{
		Title:    c.T("app.delete_the_clip", "name", clip.Name),
		OK:       c.T("app.delete_2"),
		Cancel:   c.T("app.cancel"),
		OnCancel: c.CloseModal,
		OnSubmit: func([]string) {
			c.CloseModal()
			b.run(func() error { return b.Session.DeleteClip(clip.ID) })
		},
	}
	c.OpenModal(&b.prompt)
}
