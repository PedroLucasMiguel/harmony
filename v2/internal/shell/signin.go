package shell

import (
	"context"
	"sync/atomic"
	"time"

	"harmony/v2/internal/app"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/store"
)

// resumeSession brings a server up on the session token saved for it.
func (sh *Shell) resumeSession(ctx context.Context, address, serverPassword, token string) (*app.Session, error) {
	opt := sh.sessionOptions(address, serverPassword)
	session, err := app.Resume(ctx, opt, token)
	if err == nil {
		sh.configure(session)
	}
	return session, err
}

// relogin is what a session does when the server stops accepting its token: sign in again with the remembered password, once. A password that is refused is not tried again.
func (sh *Shell) relogin(address string) func(ctx context.Context, client *hclient.Client) bool {
	var refused atomic.Bool
	return func(ctx context.Context, client *hclient.Client) bool {
		saved, known := sh.settings.Server(address)
		creds := store.LoadCredentials(address)
		if refused.Load() || !known || saved.Username == "" || creds.Password == "" {
			return false
		}
		client.Token = ""
		if err := client.Login(ctx, saved.Username, creds.Password); err != nil {
			refused.Store(true)
			return false
		}
		_ = store.UpdateCredentials(address, func(c *store.Credentials) { c.Token = client.Token })
		return true
	}
}

// sessionEnded is the server ending a session: the person is told why on the sign-in screen of that server.
func (sh *Shell) sessionEnded(address string, end app.Ended) {
	if h := sh.servers.held; h != nil && h.url == address {
		sh.heldEnded(end)
		return
	}
	if sh.open != address {
		return
	}
	t := sh.strings()
	var text string
	switch {
	case end.Kind == app.EndExpired:
		text = t.T("app.this_session_expired_sign_in")
	case end.Kind == app.EndKicked && end.Reason == "account removed":
		text = t.T("session.account_removed")
	case end.Kind == app.EndKicked && end.Reason == "kicked":
		text = t.T("session.kicked")
	case end.Kind == app.EndKicked && end.Reason == "banned":
		text = t.T("session.banned")
	case end.Kind == app.EndKicked:
		text = t.T("session.disconnected", "reason", end.Reason)
	default:
		text = t.T("session.disconnected", "reason", "not allowed")
	}
	if end.Kind != app.EndClosed {
		_ = store.UpdateCredentials(address, func(c *store.Credentials) { c.Token = "" })
	}
	sh.signOut()
	sh.showConnect(address).Notice(text)
}

// forgetSession is signing out on purpose: the session is revoked on the server and its token forgotten here, and the remembered password stays.
func (sh *Shell) forgetSession(session *app.Session, address string) {
	if session == nil {
		return
	}
	client := session.Client()
	token := client.Token
	_ = store.UpdateCredentials(address, func(c *store.Credentials) { c.Token = "" })
	go func() {
		revoke := hclient.New(client.Base, client.Password, false)
		revoke.Token = token
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = revoke.Logout(ctx)
	}()
}
