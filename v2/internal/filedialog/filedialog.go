// Package filedialog asks the system for files to attach.
package filedialog

import "github.com/ncruces/zenity"

// Pick shows the system's open dialog and returns the chosen files; nothing chosen is not an error.
func Pick(title string) []string {
	files, err := zenity.SelectFileMultiple(zenity.Title(title))
	if err != nil {
		return nil
	}
	return files
}
