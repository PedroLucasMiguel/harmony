// Package i18n looks translations up in the language files shared with the Electron client.
package i18n

import (
	"encoding/json"
	"strings"
	"sync"

	"harmony/v2/assets"
)

type Language struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

type Bundle struct {
	code     string
	current  map[string]any
	fallback map[string]any
}

var languageTable struct {
	once sync.Once
	list []Language
}

// Languages is the languages there are translations for, the first being English; the list must not be changed.
func Languages() []Language {
	languageTable.once.Do(func() {
		data, _ := assets.FS.ReadFile("locales/languages.json")
		_ = json.Unmarshal(data, &languageTable.list)
	})
	return languageTable.list
}

func Resolve(preference string, system []string) string {
	languages := Languages()
	find := func(code string) string {
		for _, l := range languages {
			if strings.EqualFold(l.Code, code) {
				return l.Code
			}
		}
		return ""
	}
	if preference != "" && preference != "auto" {
		if code := find(preference); code != "" {
			return code
		}
		return languages[0].Code
	}
	for _, candidate := range system {
		if code := find(candidate); code != "" {
			return code
		}
		primary := strings.ToLower(strings.SplitN(candidate, "-", 2)[0])
		for _, l := range languages {
			if strings.ToLower(strings.SplitN(l.Code, "-", 2)[0]) == primary {
				return l.Code
			}
		}
	}
	return languages[0].Code
}

func Load(code string) *Bundle {
	english := read(Languages()[0].Code)
	if code == Languages()[0].Code {
		return &Bundle{code: code, current: english, fallback: english}
	}
	return &Bundle{code: code, current: read(code), fallback: english}
}

func read(code string) map[string]any {
	data, err := assets.FS.ReadFile("locales/" + code + ".json")
	if err != nil {
		return map[string]any{}
	}
	var table map[string]any
	_ = json.Unmarshal(data, &table)
	return table
}

func (b *Bundle) Code() string { return b.code }

func (b *Bundle) T(key string, vars ...string) string {
	text, ok := b.current[key].(string)
	if !ok {
		text, ok = b.fallback[key].(string)
	}
	if !ok {
		return key
	}
	return b.fill(text, vars)
}

func (b *Bundle) fill(text string, vars []string) string {
	if !strings.Contains(text, "{") {
		return text
	}
	for i := 0; i+1 < len(vars); i += 2 {
		text = strings.ReplaceAll(text, "{"+vars[i]+"}", vars[i+1])
	}
	return text
}

// Plural is T for a text that has one form for a single thing and another for several, as {"one": "...", "other": "..."}.
func (b *Bundle) Plural(key string, n int, vars ...string) string {
	form := "other"
	if n == 1 {
		form = "one"
	}
	for _, table := range []map[string]any{b.current, b.fallback} {
		if forms, ok := table[key].(map[string]any); ok {
			if text, ok := forms[form].(string); ok {
				return b.fill(text, vars)
			}
		}
	}
	return key
}
