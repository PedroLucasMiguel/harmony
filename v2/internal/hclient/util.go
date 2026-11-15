package hclient

import (
	"net/url"
	"strconv"
)

func base36(n int) string { return strconv.FormatInt(int64(n), 36) }

func urlEscape(s string) string { return url.QueryEscape(s) }
