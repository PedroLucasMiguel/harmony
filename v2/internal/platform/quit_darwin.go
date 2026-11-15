package platform

import "github.com/ebitengine/purego/objc"

const (
	eventKeyDown = 10
	flagCommand  = 1 << 20
	flagMask     = 0xffff0000
)

var (
	selCurrentEvent = objc.RegisterName("currentEvent")
	selEventType    = objc.RegisterName("type")
	selModifiers    = objc.RegisterName("modifierFlags")
	selBareChars    = objc.RegisterName("charactersIgnoringModifiers")
	selEqualString  = objc.RegisterName("isEqualToString:")
)

// QuitKey says whether the event being handled is Command+Q, which the system's menu turns into a close of the window; the program should end then, not hide in the tray.
func QuitKey() bool {
	event := objc.ID(classApp).Send(selSharedApp).Send(selCurrentEvent)
	if event == 0 || objc.Send[uint](event, selEventType) != eventKeyDown || objc.Send[uint](event, selModifiers)&flagMask != flagCommand {
		return false
	}
	pool := newPool()
	defer pool.Send(selDrain)
	q := objc.ID(classString).Send(selNewString, "q")
	return objc.Send[bool](event.Send(selBareChars), selEqualString, q)
}
