package main

import (
	"net/url"
	"strings"
)

func originOf(raw string) string {
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		if i := strings.Index(raw, "://"); i >= 0 {
			rest := raw[i+3:]
			if j := strings.IndexAny(rest, "/?"); j >= 0 {
				rest = rest[:j]
			}
			return raw[:i+3] + rest
		}
		return raw
	}
	return u.Scheme + "://" + u.Host
}
