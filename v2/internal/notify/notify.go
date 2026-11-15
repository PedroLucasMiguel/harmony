// Package notify shows operating system notifications. Each system has its own file; none needs cgo.
package notify

// Notification is a title and a line of text; OnClick, when the system reports clicks, runs from a goroutine of its own.
type Notification struct {
	Title   string
	Body    string
	OnClick func()
}

// Clickable says whether this system tells the program when a notification is clicked.
func Clickable() bool { return clickable }

// Balloon is how Windows shows a notification: the tray icon's balloon. The tray package's icon sets it.
var Balloon func(title, body string, onClick func())
