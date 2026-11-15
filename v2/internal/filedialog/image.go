package filedialog

import "github.com/ncruces/zenity"

// PickImage shows the system's open dialog for one picture and returns its path; nothing chosen gives "".
func PickImage(title string) string {
	file, err := zenity.SelectFile(zenity.Title(title), zenity.FileFilters{{Name: "Images", Patterns: []string{"*.png", "*.jpg", "*.jpeg", "*.webp", "*.gif"}, CaseFold: true}})
	if err != nil {
		return ""
	}
	return file
}
