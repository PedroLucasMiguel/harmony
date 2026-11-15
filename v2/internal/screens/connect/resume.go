package connect

import (
	"context"
	"errors"

	"harmony/v2/internal/app"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/store"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
)

// Resume is how far the screen goes on its own when it opens a server that was signed in to before.
type Resume int

const (
	// Manual waits for the person.
	Manual Resume = iota
	// Launch is the program starting: in with the saved session if it is good and automatic sign-in is on.
	Launch
	// Pick is the server being chosen from the rail: in with the saved session, or with the remembered password.
	Pick
)

// savedSignIn is what the system's secret store holds for the server the screen is on, and what became of it.
type savedSignIn struct {
	creds    store.Credentials
	credsFor string
	// user is the account the saved session belongs to, once the server has said it is still good.
	user *hclient.User
	how  Resume
	// notice is what the account step says when it opens, as when the server ended the session.
	notice string
}

// OpenSaved opens the server and, as how says, goes in with what was saved.
func (s *Screen) OpenSaved(url string, how Resume) {
	s.mu.Lock()
	s.saved.how = how
	s.mu.Unlock()
	s.Open(url)
}

// Notice has the account step say why the person is here; it is shown once the server has answered.
func (s *Screen) Notice(text string) {
	s.mu.Lock()
	s.saved.notice = text
	s.mu.Unlock()
}

// credentialsOf reads the secret store once for each server the screen is on.
func (s *Screen) credentialsOf(address string) store.Credentials {
	s.mu.Lock()
	if s.saved.credsFor == address {
		defer s.mu.Unlock()
		return s.saved.creds
	}
	s.mu.Unlock()
	creds := store.LoadCredentials(address)
	s.mu.Lock()
	s.saved.creds, s.saved.credsFor, s.saved.user = creds, address, nil
	s.mu.Unlock()
	return creds
}

// resumeSignIn is what follows the server answering: the saved session is asked whether it is still good, and when it
// is and the mode allows, the person is in. A session that has expired falls back to the remembered password, and
// anything that does not get in leaves the form, with the password filled in where there is one.
func (s *Screen) resumeSignIn() {
	s.mu.Lock()
	how, address, door := s.saved.how, s.address, s.serverPassword.Value
	s.saved.how = Manual
	creds := s.saved.creds
	s.mu.Unlock()
	saved, _ := s.Settings.Server(address)
	asked := false
	if creds.Token != "" {
		asked = true
		ctx, cancel := context.WithTimeout(context.Background(), signInTimeout)
		client := hclient.New(address, door, false)
		client.Token = creds.Token
		user, err := client.Me(ctx)
		cancel()
		switch {
		case err == nil:
			s.setSigned(&user)
			if how == Manual || how == Launch && !s.Settings.AutoSignIn {
				return
			}
			s.enter(user.Nickname, true, "", func(ctx context.Context) (*app.Session, error) {
				return s.Resume(ctx, address, door, creds.Token)
			})
			return
		case hclient.IsExpired(err):
			_ = store.UpdateCredentials(address, func(c *store.Credentials) { c.Token = "" })
			s.mu.Lock()
			s.saved.creds.Token = ""
			s.mu.Unlock()
		default:
			s.fail(err.Error())
			return
		}
	}
	if creds.Password == "" || saved.Username == "" {
		return
	}
	s.password.Value = creds.Password
	if how != Manual && (asked || how == Pick) && (how == Pick || s.Settings.AutoSignIn) {
		s.enter(saved.Username, true, "", func(ctx context.Context) (*app.Session, error) {
			return s.Connect(ctx, address, door, saved.Username, creds.Password)
		})
	}
}

func (s *Screen) setSigned(user *hclient.User) {
	s.mu.Lock()
	s.saved.user = user
	s.username.Value = user.Nickname
	s.mu.Unlock()
	redraw.Request()
}

// signOutSaved ends the saved session on the server and asks for the password again, which is filled in where it was remembered.
func (s *Screen) signOutSaved() {
	s.mu.Lock()
	address, door, token := s.address, s.serverPassword.Value, s.saved.creds.Token
	s.saved.user, s.saved.creds.Token = nil, ""
	s.password.Value = s.saved.creds.Password
	s.mu.Unlock()
	go endSession(address, door, token)
	redraw.Request()
}

// endSession revokes a session token on its server and forgets it here.
func endSession(address, door, token string) {
	_ = store.UpdateCredentials(address, func(c *store.Credentials) { c.Token = "" })
	if token == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), signInTimeout)
	defer cancel()
	client := hclient.New(address, door, false)
	client.Token = token
	_ = client.Logout(ctx)
}

// continueSigned goes in with the saved session the person is shown as signed in with.
func (s *Screen) continueSigned() {
	s.mu.Lock()
	user, address, door, token := s.saved.user, s.address, s.serverPassword.Value, s.saved.creds.Token
	s.mu.Unlock()
	if user == nil {
		return
	}
	s.enter(user.Nickname, true, "", func(ctx context.Context) (*app.Session, error) { return s.Resume(ctx, address, door, token) })
}

// enter signs in with open and, when that works, remembers the sign-in and hands the session on.
func (s *Screen) enter(nick string, remember bool, password string, open func(ctx context.Context) (*app.Session, error)) {
	if !s.begin() {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), signInTimeout)
		defer cancel()
		session, err := open(ctx)
		s.mu.Lock()
		s.busy = false
		if err != nil {
			s.errText = err.Error()
			var api *hclient.APIError
			switch {
			case errors.As(err, &api) && api.Code == "bad_password":
				s.step, s.needsPassword = stepServer, true
			case hclient.IsExpired(err):
				s.saved.user, s.password.Value = nil, ""
			}
		}
		s.mu.Unlock()
		redraw.Request()
		if err == nil {
			s.rememberAccount(nick, remember, password, session)
			s.OnSignedIn(session, s.address)
		}
	}()
}

func (s *Screen) rememberAccount(nick string, remember bool, password string, session *app.Session) {
	saved := store.Server{URL: s.address, Name: s.serverName}
	if remember {
		saved.Username = nick
	}
	s.Settings.RememberServer(saved)
	if !remember {
		s.Settings.ClearUsername(s.address)
	}
	s.Settings.Save()
	token, door := session.Client().Token, s.serverPassword.Value
	_ = store.UpdateCredentials(s.address, func(c *store.Credentials) {
		if remember {
			c.Token = token
			if password != "" {
				c.Password = password
			}
		} else {
			c.Token, c.Password = "", ""
		}
		if door != "" {
			c.Door = door
		}
	})
}

// forgetCredentials removes a forgotten server's sign-in everywhere: the session on the server, and what is kept here.
func forgetCredentials(url string) {
	go func() {
		creds := store.LoadCredentials(url)
		endSession(url, creds.Door, creds.Token)
		_ = store.ForgetCredentials(url)
	}()
}

// lockedField is a field that shows a fixed text and cannot be typed in, for a password that is saved and not known.
type lockedField struct {
	field *widget.TextField
	text  string
}

func (l lockedField) Measure(c *widget.Context, maxWidth float32) geom.Size {
	return l.field.Measure(c, maxWidth)
}

func (l lockedField) Draw(c *widget.Context, r geom.Rect) {
	l.field.Value = l.text
	l.field.Draw(c, r)
}

func signedAs(c *widget.Context, user *hclient.User) string {
	name := user.DisplayName
	if name == "" {
		name = user.Nickname
	}
	return c.T("app.signed_in_as", "name", name)
}
