package settings

import (
	"context"
	"errors"
	"slices"
	"strings"
	"time"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/widget"
)

const (
	passwordMin     = 6
	securityTimeout = 20 * time.Second
	questionMax     = 140
	answerMax       = 200
	questionCount   = 3
	fieldGap        = 9.6
	questionGap     = 9.6
	actionsGap      = 8
	questionWeight  = 1.4
)

var knownErrors = []string{"need_three", "bad_question", "repeated_question", "bad_answer", "bad_credentials", "locked_out", "weak_password"}

type security struct {
	d *Dialog

	current, next, confirm widget.TextField
	change                 widget.Button
	autoSignIn             widget.Switch
	changed                feedback

	questions, answers [questionCount]widget.TextField
	recoveryPassword   widget.TextField
	save, remove       widget.Button
	configured         bool
	loaded             bool
	recovered          feedback
	busy               bool
}

func newSecurity(d *Dialog) *security {
	s := &security{d: d}
	for _, f := range []*widget.TextField{&s.current, &s.next, &s.confirm, &s.recoveryPassword} {
		f.Inset, f.Password = true, true
	}
	for i := range s.questions {
		s.questions[i].Inset, s.questions[i].MaxLength = true, questionMax
		s.answers[i].Inset, s.answers[i].MaxLength = true, answerMax
	}
	s.change.OnClick = s.changePassword
	s.autoSignIn.On = d.Settings.AutoSignIn
	s.autoSignIn.OnChange = func(on bool) { d.Settings.AutoSignIn = on; d.save() }
	s.save.OnClick = s.saveQuestions
	s.remove.Variant, s.remove.OnClick = widget.Ghost, s.removeQuestions
	return s
}

func (s *security) icon() string                   { return "shield-check" }
func (s *security) label(c *widget.Context) string { return c.T("settings.security") }

// run does the request off the interface's thread and hands what came back to done on it.
func (s *security) run(request func(ctx context.Context, client *hclient.Client) error, done func(err error)) {
	s.busy = true
	s.d.invalidate()
	c, client := s.d.ctx, s.d.Session.Client()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), securityTimeout)
		defer cancel()
		err := request(ctx, client)
		c.Post(func() {
			s.busy = false
			done(err)
			s.d.invalidate()
		})
	}()
}

func (s *security) explain(err error) string {
	var api *hclient.APIError
	if errors.As(err, &api) && slices.Contains(knownErrors, api.Code) {
		return s.d.ctx.T("security.err_" + api.Code)
	}
	return err.Error()
}

func (s *security) changePassword() {
	c := s.d.ctx
	current, password := s.current.Value, s.next.Value
	switch {
	case current == "" || password == "":
		s.changed.set(c.T("security.fill_everything"), true)
	case len(password) < passwordMin:
		s.changed.set(c.T("security.too_short"), true)
	case password != s.confirm.Value:
		s.changed.set(c.T("security.passwords_differ"), true)
	default:
		s.changed.clear()
		s.run(func(ctx context.Context, client *hclient.Client) error {
			return client.ChangePassword(ctx, current, password)
		}, func(err error) {
			if err != nil {
				s.changed.set(s.explain(err), true)
				return
			}
			s.current.Value, s.next.Value, s.confirm.Value = "", "", ""
			s.changed.set(c.T("security.password_changed"), false)
		})
	}
	s.d.invalidate()
}

func (s *security) show(state hclient.RecoveryState) {
	s.configured = state.Configured
	for i := range s.questions {
		if state.Configured && i < len(state.Questions) {
			s.questions[i].Value = state.Questions[i]
		}
		s.answers[i].Value = ""
	}
}

func (s *security) load() {
	s.loaded = true
	s.run(func(ctx context.Context, client *hclient.Client) error {
		state, err := client.RecoveryStatus(ctx)
		s.d.ctx.Post(func() { s.show(state) })
		return err
	}, func(err error) {
		if err != nil {
			s.recovered.set(s.explain(err), true)
		}
	})
}

func (s *security) saveQuestions() {
	c := s.d.ctx
	items := make([]hclient.RecoveryItem, questionCount)
	for i := range items {
		items[i] = hclient.RecoveryItem{Question: s.questions[i].Value, Answer: s.answers[i].Value}
		if strings.TrimSpace(items[i].Question) == "" || strings.TrimSpace(items[i].Answer) == "" {
			s.recovered.set(c.T("security.fill_everything"), true)
			s.d.invalidate()
			return
		}
	}
	current := s.recoveryPassword.Value
	if current == "" {
		s.recovered.set(c.T("security.fill_everything"), true)
		s.d.invalidate()
		return
	}
	s.recovered.clear()
	s.run(func(ctx context.Context, client *hclient.Client) error {
		state, err := client.SetRecovery(ctx, current, items)
		if err == nil {
			c.Post(func() { s.show(state) })
		}
		return err
	}, func(err error) {
		if err != nil {
			s.recovered.set(s.explain(err), true)
			return
		}
		s.recoveryPassword.Value = ""
		s.recovered.set(c.T("security.recovery_saved"), false)
	})
}

func (s *security) removeQuestions() {
	c := s.d.ctx
	current := s.recoveryPassword.Value
	if current == "" {
		s.recovered.set(c.T("security.type_current_password"), true)
		s.d.invalidate()
		return
	}
	s.recovered.clear()
	s.run(func(ctx context.Context, client *hclient.Client) error { return client.ClearRecovery(ctx, current) }, func(err error) {
		if err != nil {
			s.recovered.set(s.explain(err), true)
			return
		}
		s.show(hclient.RecoveryState{})
		s.recoveryPassword.Value = ""
		s.recovered.set(c.T("security.recovery_removed"), false)
	})
}

func (s *security) build(c *widget.Context) widget.Component {
	if !s.loaded {
		s.load()
	}
	s.change.Label, s.change.Disabled = c.T("security.change_password"), s.busy
	s.save.Label, s.save.Disabled = c.T("security.save_recovery"), s.busy
	s.remove.Label, s.remove.Disabled = c.T("security.remove_recovery"), s.busy
	for i := range s.answers {
		s.answers[i].Placeholder = c.T("security.answer_placeholder")
		if s.configured {
			s.answers[i].Placeholder = c.T("security.answer_again")
		}
	}
	s.questions[0].Placeholder = c.T("security.question_placeholder")

	password := []widget.Component{
		widget.SettingNote{Content: c.T("security.password_hint")},
		widget.Padded{Bottom: fieldGap, Child: widget.DialogField(c.T("security.current_password"), &s.current)},
		widget.Padded{Bottom: fieldGap, Child: widget.DialogField(c.T("security.new_password"), &s.next)},
		widget.Padded{Bottom: fieldGap, Child: widget.DialogField(c.T("security.confirm_password"), &s.confirm)},
		widget.Start{Child: &s.change},
	}
	password = append(password, s.changed.note()...)

	status := c.T("security.recovery_off")
	if s.configured {
		status = c.T("security.recovery_on")
	}
	recovery := []widget.Component{
		widget.SettingNote{Content: c.T("security.recovery_hint")},
		widget.SettingNote{Content: status, Bold: true},
	}
	for i := range s.questions {
		n := string(rune('1' + i))
		recovery = append(recovery, widget.Padded{Bottom: questionGap, Child: &widget.Row{Gap: questionGap, Items: []widget.RowItem{
			widget.GrowBy(questionWeight, widget.DialogField(c.T("security.question_"+n), &s.questions[i])),
			widget.Grow(widget.DialogField(c.T("security.answer_"+n), &s.answers[i])),
		}}})
	}
	actions := []widget.RowItem{widget.Fixed(&s.save)}
	if s.configured {
		actions = append(actions, widget.Fixed(&s.remove))
	}
	recovery = append(recovery,
		widget.Padded{Bottom: fieldGap, Child: widget.DialogField(c.T("security.current_password"), &s.recoveryPassword)},
		&widget.Row{Gap: actionsGap, Items: actions},
		widget.SettingNote{Content: c.T("security.answers_note")},
	)
	recovery = append(recovery, s.recovered.note()...)

	return widget.Col(0,
		widget.PageTitle(c.T("security.title")),
		&widget.SettingCard{Children: []widget.Component{
			widget.ToggleRow{Title: c.T("security.auto_sign_in"), Hint: c.T("security.auto_sign_in_hint"), Switch: &s.autoSignIn},
		}},
		&widget.SettingCard{Title: c.T("security.password_title"), Children: password},
		&widget.SettingCard{Title: c.T("security.recovery_title"), Children: recovery},
	)
}
