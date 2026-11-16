package connect

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
)

const probeTimeout = 10 * time.Second

func (s *Screen) serverStep(c *widget.Context) widget.Component {
	s.serverURL.Placeholder = c.T("step_server.https_harmony_example_com")
	s.serverURL.OnEnter = s.probe
	s.serverPassword.Placeholder = c.T("password_field.this_server_asks_for")
	s.serverPassword.OnEnter = s.probe

	children := []widget.Component{widget.Field(c.T("step_server.server_address"), &s.serverURL)}
	s.mu.Lock()
	needsPassword, asked, busy := s.needsPassword, s.passwordAsked, s.busy
	s.mu.Unlock()
	note := c.T("app.the_address_you_were_given")
	if needsPassword {
		children = append(children, widget.Field(c.T("password_field.server_password"), &s.serverPassword))
		if asked {
			note = c.T("app.this_server_asks_for_a")
		}
	}
	children = append(children,
		hint(note),
		&widget.Button{Label: c.T("app.continue"), Variant: widget.Primary, Disabled: busy, OnClick: s.probe},
	)
	if s.backTo != "" {
		children = append(children, widget.Padded{Top: switchAuthTop, Child: &widget.Button{
			Label: c.T("server_back.back_to_my_servers"), Variant: widget.Link, Size: switchAuthSize, Opacity: switchAuthAlpha, OnClick: s.back,
		}})
	}
	return widget.Col(cardGap, children...)
}

// probe asks the server about itself, with the password typed if there is one. The server answers its health to anybody, so
// a password that is wanted shows in what it says and is checked there; the sign-in only goes on once the server accepts it.
func (s *Screen) probe() {
	address := strings.TrimSpace(s.serverURL.Value)
	if address == "" || !s.begin() {
		return
	}
	texts := s.Strings()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
		defer cancel()
		client := hclient.New(address, s.serverPassword.Value, false)
		creds := s.credentialsOf(client.Base)
		if client.Password == "" && creds.Door != "" {
			client.Password = creds.Door
			s.serverPassword.Value = creds.Door
		}
		health, err := client.Health(ctx)
		resume := false
		s.mu.Lock()
		defer func() {
			s.mu.Unlock()
			redraw.Request()
			if resume {
				s.resumeSignIn()
			}
		}()
		s.busy = false
		var refused *hclient.APIError
		switch {
		case errors.As(err, &refused) && (refused.Status == http.StatusUnauthorized || refused.Status == http.StatusTooManyRequests):
			s.needsPassword, s.passwordAsked = true, false
			s.errText = refused.Message
		case err != nil:
			s.errText = err.Error()
		case health.PasswordRequired && !health.Authenticated:
			s.needsPassword = true
			s.passwordAsked = client.Password == ""
			if !s.passwordAsked {
				s.errText = texts.T("connect.wrong_password")
			}
			s.serverPassword.RequestFocus()
		default:
			s.needsPassword, s.passwordAsked = health.PasswordRequired, false
			s.address, s.serverName = client.Base, health.Name
			s.needsOwner, s.registering = health.NeedsOwner, !health.HasAccounts
			s.serverUp, s.step, s.errText = widget.ServerUp, stepAccount, s.saved.notice
			s.saved.notice, s.saved.user = "", nil
			s.fillSavedAccount()
			resume = creds.Token != "" || creds.Password != ""
		}
	}()
}

func (s *Screen) begin() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.busy {
		return false
	}
	s.busy, s.errText = true, ""
	return true
}

func (s *Screen) fillSavedAccount() {
	if saved, ok := s.Settings.Server(s.address); ok && s.username.Value == "" {
		s.username.Value = saved.Username
	}
	if s.username.Value == "" {
		s.username.RequestFocus()
	} else {
		s.password.RequestFocus()
	}
}
