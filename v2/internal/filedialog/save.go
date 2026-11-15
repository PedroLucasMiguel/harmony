package filedialog

import "github.com/ncruces/zenity"

// Save shows the system's save dialog, suggesting a file name, and returns the chosen path; nothing chosen gives "".
func Save(title, name string) string {
	path, err := zenity.SelectFileSave(zenity.Title(title), zenity.Filename(name), zenity.ConfirmOverwrite())
	if err != nil {
		return ""
	}
	return path
}
