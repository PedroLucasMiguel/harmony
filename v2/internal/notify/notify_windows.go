package notify

// A balloon from the tray icon: it needs no registration of the program with the shell, and the icon is told when it is clicked.
const clickable = true

// Show puts the notification on screen through Balloon, which the tray sets once its icon is up.
func Show(n Notification) error {
	if Balloon != nil {
		Balloon(n.Title, n.Body, n.OnClick)
	}
	return nil
}
