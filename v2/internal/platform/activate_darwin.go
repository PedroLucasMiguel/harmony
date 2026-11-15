package platform

import "github.com/ebitengine/purego/objc"

// Activate makes the program the one in front, which a window shown again from the menu bar needs before it can take keys.
func Activate() {
	pool := newPool()
	defer pool.Send(selDrain)
	objc.ID(classApp).Send(selSharedApp).Send(objc.RegisterName("activateIgnoringOtherApps:"), true)
}
