package serveradmin

import (
	"context"
	"strings"

	"harmony/v2/internal/app"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/widget"
)

// MembersAllowed is whether the person has anything to do on the Members page, which is also whether the member menu offers it.
func MembersAllowed(a hclient.Actor) bool { return (&membersPage{}).visible(a) }

// CanDeleteAccount is whether the person may remove this account: only the owner, and never the owner's own.
func CanDeleteAccount(st *app.State, id int) bool {
	user, ok := accountOf(st, id)
	return ok && st.Actor.Owner && user.Role != "owner" && id != st.Me.ID
}

// DeleteAccount asks twice before it removes an account and everything written under it: the second time for the nickname.
func DeleteAccount(c *widget.Context, session *app.Session, id int) {
	user, ok := accountOf(session.State(), id)
	if !ok {
		return
	}
	who := user.Name()
	c.OpenModal(&widget.Prompt{
		Title: c.T("app.delete_s_account", "who", who), Text: c.T("account.delete_details"),
		OK: c.T("app.continue"), Cancel: c.T("app.cancel"),
		OnCancel: c.CloseModal,
		OnSubmit: func([]string) { typeNickname(c, session, user) },
	})
}

func typeNickname(c *widget.Context, session *app.Session, user hclient.Account) {
	field := &widget.PromptField{Label: c.T("app.nickname"), Required: true}
	prompt := &widget.Prompt{
		Title: c.T("app.type_to_confirm", "nickname", user.Nickname), Text: c.T("app.this_is_the_last_step"),
		Fields: []*widget.PromptField{field},
		OK:     c.T("app.delete_the_account"), Cancel: c.T("app.cancel"),
		OnCancel: c.CloseModal,
	}
	prompt.OnSubmit = func(values []string) {
		if strings.ToLower(strings.TrimSpace(values[0])) != user.Nickname {
			prompt.Text = c.T("app.that_is_not_the_right")
			return
		}
		prompt.Busy = true
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), sendTimeout)
			defer cancel()
			_, err := session.DeleteAccount(ctx, user.ID)
			c.Post(func() {
				if err != nil {
					prompt.Busy, prompt.Text = false, err.Error()
					return
				}
				c.CloseModal()
			})
		}()
	}
	c.OpenModal(prompt)
}
