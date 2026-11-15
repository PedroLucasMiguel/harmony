package settings

import (
	"context"
	"errors"
	"os"
	"strconv"

	"harmony/v2/internal/filedialog"
	"harmony/v2/internal/joinsound"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

const (
	soundGap       = 12
	soundStateSize = 14
)

// sound is the Join sound card of the page.
type sound struct {
	p      *profile
	play   widget.Button
	choose widget.Button
	remove widget.Button
}

func newSound(p *profile) *sound {
	k := &sound{p: p}
	k.play.Variant = widget.Ghost
	k.play.OnClick = p.d.Session.PreviewJoinSound
	k.remove.Variant = widget.Ghost
	k.remove.OnClick = k.clear
	k.choose.OnClick = k.pick
	return k
}

func (k *sound) report(text string, failed bool) {
	k.p.notes.sound.set(text, failed)
	k.p.d.invalidate()
}

func (k *sound) pick() {
	c, s := k.p.d.ctx, k.p.d.Session
	go func() {
		picked := filedialog.Pick(c.T("profile_sound.choose_sound"))
		if len(picked) == 0 {
			return
		}
		res, err := convert(picked[0])
		var hash string
		if err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), uploadTimeout)
			defer cancel()
			if hash, err = s.UploadFile(ctx, res.WAV, "audio/wav"); err == nil {
				err = s.SetJoinSound(ctx, hash)
			}
		}
		c.Post(func() {
			switch {
			case errors.Is(err, joinsound.ErrTooBig):
				k.report(c.T("profile.join_sound_too_big"), true)
			case errors.Is(err, joinsound.ErrUnreadable):
				k.report(c.T("profile.join_sound_unreadable"), true)
			case err != nil:
				k.report(err.Error(), true)
			case res.Trimmed:
				k.report(c.T("profile.join_sound_trimmed", "seconds", strconv.Itoa(joinsound.MaxSeconds)), false)
			default:
				k.report(c.T("profile.join_sound_changed", "seconds", strconv.FormatFloat(res.Seconds, 'f', 1, 64)), false)
			}
		})
	}()
}

func convert(path string) (joinsound.Result, error) {
	info, err := os.Stat(path)
	if err != nil {
		return joinsound.Result{}, joinsound.ErrUnreadable
	}
	if info.Size() > joinsound.MaxSourceSize {
		return joinsound.Result{}, joinsound.ErrTooBig
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return joinsound.Result{}, joinsound.ErrUnreadable
	}
	return joinsound.Convert(data)
}

func (k *sound) clear() {
	c, s := k.p.d.ctx, k.p.d.Session
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), nameTimeout)
		defer cancel()
		err := s.SetJoinSound(ctx, "")
		c.Post(func() {
			if err != nil {
				k.report(err.Error(), true)
				return
			}
			k.report(c.T("profile.join_sound_removed"), false)
		})
	}()
}

func (k *sound) card(c *widget.Context, me *meView) widget.Component {
	k.play.Label, k.choose.Label, k.remove.Label = c.T("profile_sound.play"), c.T("profile_sound.choose_sound"), c.T("profile_sound.remove_sound")
	k.remove.Disabled = me.soundHash == ""
	state := c.T("profile.join_sound_default")
	if me.soundHash != "" {
		state = c.T("profile.join_sound_custom")
	}
	row := widget.Padded{Bottom: groupGap, Child: &widget.Row{Gap: soundGap, Items: []widget.RowItem{
		widget.Grow(stateLabel{state}),
		widget.Fixed(&widget.Row{Gap: profileButtonGap, Items: []widget.RowItem{widget.Fixed(&k.play), widget.Fixed(&k.choose), widget.Fixed(&k.remove)}}),
	}}}
	return &widget.SettingCard{Title: c.T("settings.profile.join_sound"), Children: append([]widget.Component{
		row, widget.SettingNote{Content: c.T("settings.profile.join_sound_note")},
	}, k.p.notes.sound.component()...)}
}

// stateLabel is a line of muted text that takes the room it is given.
type stateLabel struct{ text string }

func (stateLabel) Measure(_ *widget.Context, w float32) geom.Size {
	return geom.Size{W: w, H: soundStateSize * 1.5}
}

func (s stateLabel) Draw(c *widget.Context, r geom.Rect) {
	c.Paint.TextIn(r, s.text, r.X, r.Y, r.H, paint.TextStyle{Size: soundStateSize, Weight: paint.Regular}, c.Theme.Muted)
}
