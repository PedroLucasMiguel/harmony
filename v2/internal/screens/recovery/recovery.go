// Package recovery gets somebody back into their account: the three questions they wrote while signed in, then a new password.
package recovery

import (
	"context"
	"errors"
	"strconv"
	"time"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/widget"
)

const (
	requestTimeout = 20 * time.Second
	passwordMin    = 6
)

// Flow walks the steps as a chain of prompts; each answer from the server opens the next one.
type Flow struct {
	c      *widget.Context
	client *hclient.Client
	// OnDone is told the account and its new password once it has been reset.
	OnDone func(nickname, password string)

	nickname  string
	questions []string
	answers   []string
	token     string
}

// Start opens the first question; typed is whatever was already in the username box.
func Start(c *widget.Context, client *hclient.Client, typed string, onDone func(nickname, password string)) {
	f := &Flow{c: c, client: client, OnDone: onDone}
	f.askName(typed)
}

func (f *Flow) T(key string, vars ...string) string { return f.c.T(key, vars...) }

func (f *Flow) title() string { return f.T("security.forgot_title") }

func (f *Flow) close() { f.c.CloseModal() }

func (f *Flow) show(p *widget.Prompt) { f.c.OpenModal(p) }

// inform is a message that wants reading, with one button to put it away.
func (f *Flow) inform(text string, then func()) {
	f.show(&widget.Prompt{
		Title: f.title(), Text: text, OK: f.T("security.close"),
		OnSubmit: func([]string) {
			if then != nil {
				then()
				return
			}
			f.close()
		},
		OnCancel: f.close,
	})
}

func (f *Flow) field(label, value string, password bool) *widget.PromptField {
	field := &widget.PromptField{Label: label, Required: true}
	field.Input.Value, field.Input.Password = value, password
	return field
}

func (f *Flow) askName(typed string) {
	name := f.field(f.T("account_fields.username"), typed, false)
	var prompt *widget.Prompt
	prompt = &widget.Prompt{
		Title: f.title(), Text: f.T("security.forgot_intro"), OK: f.T("security.forgot_continue"), Cancel: f.T("app.cancel"),
		Fields:   []*widget.PromptField{name},
		OnSubmit: func(v []string) { f.loadQuestions(prompt, hclient.RecoveryName(v[0])) },
		OnCancel: f.close,
	}
	f.show(prompt)
}

// busy marks the prompt as waiting for the server and runs the request off the interface's thread.
func (f *Flow) busy(prompt *widget.Prompt, work func(ctx context.Context)) {
	prompt.Busy = true
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
		defer cancel()
		work(ctx)
	}()
}

func code(err error) string {
	var api *hclient.APIError
	if errors.As(err, &api) {
		return api.Code
	}
	return ""
}

func (f *Flow) loadQuestions(prompt *widget.Prompt, nickname string) {
	if nickname == "" {
		return
	}
	f.busy(prompt, func(ctx context.Context) {
		questions, err := f.client.RecoveryQuestions(ctx, nickname)
		switch {
		case code(err) == hclient.CodeNoRecovery:
			f.inform(f.T("security.forgot_none", "name", nickname), f.close)
		case err != nil:
			f.inform(err.Error(), f.close)
		default:
			f.nickname, f.questions = nickname, questions
			f.askQuestion(0, nil)
		}
	})
}

func (f *Flow) askQuestion(i int, answers []string) {
	last := i == len(f.questions)-1
	ok := f.T("security.forgot_next")
	if last {
		ok = f.T("security.forgot_check")
	}
	answer := f.field(f.T("security.answer"), "", false)
	var prompt *widget.Prompt
	prompt = &widget.Prompt{
		Title: f.T("security.forgot_question_of", "n", strconv.Itoa(i+1), "total", strconv.Itoa(len(f.questions))),
		Text:  f.questions[i], OK: ok, Cancel: f.T("app.cancel"),
		Fields: []*widget.PromptField{answer},
		OnSubmit: func(v []string) {
			given := append(append([]string(nil), answers...), v[0])
			if !last {
				f.askQuestion(i+1, given)
				return
			}
			f.verify(prompt, given)
		},
		OnCancel: f.close,
	}
	f.show(prompt)
}

func (f *Flow) verify(prompt *widget.Prompt, answers []string) {
	f.busy(prompt, func(ctx context.Context) {
		token, err := f.client.RecoveryVerify(ctx, f.nickname, answers)
		switch code(err) {
		case "":
			if err != nil {
				f.inform(err.Error(), f.close)
				return
			}
			f.token = token
			f.askPassword(f.T("security.forgot_right"))
		case hclient.CodeWrongAnswers:
			f.inform(f.T("security.forgot_wrong"), func() { f.askQuestion(0, nil) })
		case hclient.CodeLockedOut:
			f.inform(f.T("security.forgot_locked"), f.close)
		default:
			f.inform(err.Error(), f.close)
		}
	})
}

func (f *Flow) askPassword(problem string) {
	password := f.field(f.T("security.new_password"), "", true)
	confirm := f.field(f.T("security.confirm_password"), "", true)
	var prompt *widget.Prompt
	prompt = &widget.Prompt{
		Title: f.title(), Text: problem, OK: f.T("security.forgot_save"), Cancel: f.T("app.cancel"),
		Fields: []*widget.PromptField{password, confirm},
		OnSubmit: func(v []string) {
			switch {
			case len(v[0]) < passwordMin:
				f.askPassword(f.T("security.too_short"))
			case v[0] != v[1]:
				f.askPassword(f.T("security.passwords_differ"))
			default:
				f.reset(prompt, v[0])
			}
		},
		OnCancel: f.close,
	}
	f.show(prompt)
}

func (f *Flow) reset(prompt *widget.Prompt, password string) {
	f.busy(prompt, func(ctx context.Context) {
		err := f.client.RecoveryReset(ctx, f.token, password)
		switch code(err) {
		case "":
			if err != nil {
				f.inform(err.Error(), f.close)
				return
			}
			f.close()
			f.OnDone(f.nickname, password)
		case hclient.CodeWeakPassword:
			f.askPassword(f.T("security.too_short"))
		case hclient.CodeResetExpired:
			f.inform(f.T("security.forgot_expired"), f.close)
		default:
			f.inform(err.Error(), f.close)
		}
	})
}
