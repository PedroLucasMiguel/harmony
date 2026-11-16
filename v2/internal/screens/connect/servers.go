package connect

import (
	"context"
	"time"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/store"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
)

const statusTimeout = 5 * time.Second

// syncServers keeps the list of saved servers under the server chip up to date with the settings.
func (s *Screen) syncServers(c *widget.Context) {
	m := &s.servers
	m.Placeholder = c.T("server_menu.search_servers")
	m.Empty = c.T("server_options_empty.no_servers_match")
	m.AddLabel = c.T("server_add.add_a_server")
	m.AsLabel = "as"
	if m.OnOpen == nil {
		m.OnOpen, m.OnSelect, m.OnForget, m.OnAdd = s.probeSaved, s.switchTo, s.forget, s.addServer
	}
	m.Options = m.Options[:0]
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, saved := range s.Settings.Servers {
		status := s.status[saved.URL]
		current := saved.URL == s.address
		if current {
			status = s.serverUp
		}
		m.Options = append(m.Options, widget.ServerOption{
			URL: saved.URL, Name: saved.Name, Host: hostOf(saved.URL), Username: saved.Username, Status: status, Current: current,
		})
	}
}

// probeSaved asks every saved server whether it answers, so the menu can show which ones are up.
func (s *Screen) probeSaved() {
	s.mu.Lock()
	if s.status == nil {
		s.status = map[string]widget.ServerStatus{}
	}
	saved := append([]store.Server(nil), s.Settings.Servers...)
	for _, server := range saved {
		s.status[server.URL] = widget.ServerChecking
	}
	s.mu.Unlock()

	for _, server := range saved {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), statusTimeout)
			defer cancel()
			_, err := hclient.New(server.URL, "", false).Health(ctx)
			status := widget.ServerUp
			if err != nil && !isRefusal(err) {
				status = widget.ServerUnknown
			}
			s.mu.Lock()
			s.status[server.URL] = status
			s.mu.Unlock()
			redraw.Request()
		}()
	}
}

// isRefusal tells a server that answered but wants its password apart from one that did not answer.
func isRefusal(err error) bool {
	refused, ok := err.(*hclient.APIError)
	return ok && refused.Status == 401
}

func (s *Screen) switchTo(url string) {
	if url == s.address {
		return
	}
	s.username.Value, s.password.Value, s.confirm.Value = "", "", ""
	s.mu.Lock()
	s.saved.user = nil
	s.mu.Unlock()
	s.backTo = ""
	s.Open(url)
}

func (s *Screen) forget(url string) {
	s.Settings.Forget(url)
	s.Settings.Save()
	forgetCredentials(url)
}

// addServer goes back to the first step for a new address, remembering the server to return to.
func (s *Screen) addServer() {
	s.AddServer(s.address)
}

// AddServer starts the first step again for a new address; back is the server "Back to my servers" returns to.
func (s *Screen) AddServer(back string) {
	s.mu.Lock()
	s.step, s.backTo, s.errText = stepServer, back, ""
	s.needsPassword, s.passwordAsked = false, false
	s.mu.Unlock()
	s.serverURL.Value, s.serverPassword.Value = "", ""
	s.serverURL.RequestFocus()
}

func (s *Screen) back() {
	to := s.backTo
	s.backTo = ""
	s.Open(to)
}
