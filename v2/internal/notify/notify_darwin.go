package notify

import (
	"os/exec"
	"strings"
)

// An unbundled program has no notification center to talk to: UNUserNotificationCenter needs an application bundle and
// NSUserNotificationCenter hands back nothing without a bundle identifier. The one thing that works without a bundle
// is the scripting host, which shows the notification as its own and, when clicked, opens Script Editor: so a click
// cannot be heard here.
const clickable = false

var quote = strings.NewReplacer(`\`, `\\`, `"`, `\"`)

// Show puts the notification on screen without waiting for it.
func Show(n Notification) error {
	script := `display notification "` + quote.Replace(n.Body) + `" with title "` + quote.Replace(n.Title) + `"`
	cmd := exec.Command("osascript", "-e", script)
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
