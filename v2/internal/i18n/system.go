package i18n

import (
	"os"
	"strings"
	"sync"
)

var (
	systemOnce sync.Once
	systemTags []string
)

func SystemLanguages() []string {
	systemOnce.Do(func() { systemTags = readSystemLanguages() })
	return systemTags
}

func readSystemLanguages() []string {
	var found []string
	for _, name := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		if tag := normalise(os.Getenv(name)); tag != "" {
			found = append(found, tag)
		}
	}
	return append(found, platformLanguages()...)
}

func normalise(posix string) string {
	tag, _, _ := strings.Cut(posix, ".")
	tag = strings.ReplaceAll(tag, "_", "-")
	if tag == "C" || tag == "POSIX" {
		return ""
	}
	return tag
}
