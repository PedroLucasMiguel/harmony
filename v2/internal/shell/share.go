package shell

import (
	"harmony/v2/internal/app"
	"harmony/v2/internal/screens/sharepicker"
)

// openShareChoice asks what to share; with changing set, a share is running and the choice swaps its source.
func (sh *Shell) openShareChoice(session *app.Session, changing bool) {
	state := session.State()
	target := ""
	for _, ch := range state.Channels {
		if ch.ID == state.Joined {
			target = "#" + ch.Name
		}
	}
	note, extra := sh.soundHooks(session)
	sh.context.OpenModal(sharepicker.New(sh.context, sharepicker.Options{
		Session: session, Settings: sh.settings, Target: target, Encoder: sh.encoder, Changing: changing, Note: note, Extra: extra,
	}))
}
