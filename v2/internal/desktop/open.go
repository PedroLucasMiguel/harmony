package desktop

import (
	"os/exec"
	"runtime"
)

// OpenInputSettings opens the system's page where a program is allowed to watch the keyboard and mouse (a Mac's Input Monitoring); elsewhere there is no such page.
func OpenInputSettings() {
	if runtime.GOOS == "darwin" {
		_ = exec.Command("open", "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent").Start()
	}
}
