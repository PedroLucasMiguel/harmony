package i18n

import (
	"os/exec"
	"regexp"
)

var quoted = regexp.MustCompile(`"([^"]+)"`)

func platformLanguages() []string {
	out, err := exec.Command("defaults", "read", "-g", "AppleLanguages").Output()
	if err != nil {
		return nil
	}
	var tags []string
	for _, m := range quoted.FindAllSubmatch(out, -1) {
		tags = append(tags, string(m[1]))
	}
	return tags
}
