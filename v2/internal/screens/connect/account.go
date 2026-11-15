package connect

import (
	"context"
	"strings"
	"time"

	"harmony/v2/internal/app"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
)

const signInTimeout = 30 * time.Second

func (s *Screen) accountStep(c *widget.Context) widget.Component {
	s.username.Placeholder = c.T("account_fields.your_name")
	s.password.Placeholder = ""
	passwordLabel, hintKey, connectKey := c.T("app.password"), "connect.username_hint_login", "app.connect"
	modeText, modeAction := c.T("app.no_account_yet"), c.T("app.create_one")
	if s.registering {
		s.password.Placeholder = c.T("app.at_least_6_characters")
		passwordLabel, hintKey, connectKey = c.T("app.choose_a_password"), "connect.username_hint_new", "app.create_account"
		modeText, modeAction = c.T("app.already_registered"), c.T("app.sign_in")
	}
	s.ownerKey.Placeholder = c.T("owner_key_field.printed_in_the_server")
	s.username.OnEnter, s.password.OnEnter, s.confirm.OnEnter, s.ownerKey.OnEnter = s.signIn, s.signIn, s.signIn, s.signIn

	s.mu.Lock()
	busy, name, up, needsOwner, signed := s.busy, s.serverName, s.serverUp, s.needsOwner, s.saved.user
	s.mu.Unlock()
	hide := s.Settings.HideDetails
	chip := &widget.ServerChip{Name: mask(name, hide), Host: mask(hostOf(s.address), hide), Status: up, Menu: &s.servers}
	if signed != nil {
		return s.signedStep(c, chip, signed, busy)
	}

	fields := []widget.Component{
		widget.Field(c.T("account_fields.username"), &s.username),
		widget.Field(passwordLabel, &s.password),
	}
	if s.registering {
		fields = append(fields, widget.Field(c.T("account_confirm_field.confirm_password"), &s.confirm))
		if needsOwner {
			fields = append(fields, widget.Field(c.T("owner_key_field.owner_key"), &s.ownerKey))
		}
	}
	s.remember.Content = widget.Label(c.T("account_fields.remember_me"), 13, paint.Regular, widget.ToneText)
	fields = append(fields, &s.remember)

	children := []widget.Component{
		widget.Field(c.T("step_account.server"), chip),
		widget.Col(cardGap, fields...),
		hint(c.T(hintKey)),
		&widget.Button{Label: c.T(connectKey), Variant: widget.Primary, Disabled: busy, OnClick: s.signIn},
		linkRow(c, modeText, modeAction, func() { s.registering = !s.registering }),
	}
	if !s.registering {
		children = append(children, widget.Padded{Top: forgotTop, Child: &widget.Button{
			Label: c.T("security.forgot"), Variant: widget.Link, Size: switchAuthSize, Opacity: switchAuthAlpha, OnClick: s.forgot,
		}})
	}
	return widget.Col(cardGap, children...)
}

// signedStep is the account step for a saved session that is still good: who it is, a password drawn as saved, and a way to be somebody else.
func (s *Screen) signedStep(c *widget.Context, chip widget.Component, user *hclient.User, busy bool) widget.Component {
	fields := widget.Col(cardGap,
		widget.Field(c.T("account_fields.username"), lockedField{&s.username, user.Nickname}),
		widget.Field(c.T("app.password"), lockedField{&s.password, "••••••••••"}),
	)
	return widget.Col(cardGap,
		widget.Field(c.T("step_account.server"), chip),
		fields,
		hint(signedAs(c, user)),
		&widget.Button{Label: c.T("app.connect"), Variant: widget.Primary, Disabled: busy, OnClick: s.continueSigned},
		linkRow(c, c.T("app.not_you"), c.T("app.sign_out"), s.signOutSaved),
	)
}

func hostOf(address string) string {
	_, host, found := strings.Cut(address, "://")
	if !found {
		return address
	}
	return host
}

func (s *Screen) signIn() {
	texts := s.Strings()
	nick := strings.TrimSpace(s.username.Value)
	switch {
	case nick == "":
		s.fail(texts.T("connect.pick_username"))
		return
	case s.registering && s.password.Value != s.confirm.Value:
		s.fail(texts.T("app.the_two_passwords_do_not"))
		return
	case !s.begin():
		return
	}
	s.mu.Lock()
	s.busy = false
	s.mu.Unlock()
	s.enter(nick, s.remember.Checked, s.password.Value, func(ctx context.Context) (*app.Session, error) { return s.connect(ctx, nick) })
}

func (s *Screen) fail(message string) {
	s.mu.Lock()
	s.errText = message
	s.mu.Unlock()
	redraw.Request()
}

func (s *Screen) connect(ctx context.Context, nick string) (*app.Session, error) {
	if s.registering {
		client := hclient.New(s.address, s.serverPassword.Value, false)
		if err := client.Register(ctx, nick, s.password.Value, strings.TrimSpace(s.ownerKey.Value)); err != nil {
			return nil, err
		}
	}
	return s.Connect(ctx, s.address, s.serverPassword.Value, nick, s.password.Value)
}

// forgot starts getting back into the account; once the password is new, signing in is what follows.
func (s *Screen) forgot() {
	client := hclient.New(s.address, s.serverPassword.Value, false)
	s.Recover(client, s.username.Value, func(nickname, password string) {
		s.username.Value, s.password.Value = nickname, password
		s.signIn()
	})
}
