package proxy

import (
	"embed"
	"fmt"
)

// De standaardpagina's (zelfstandige HTML, inline CSS, licht/donker). Caddy vult
// {http.request.host} in; overige accolades (CSS) laat Caddy staan omdat het geen
// bekende placeholders zijn. pages/ready.html is de standaard index.html die de
// webtemplates in een lege public/ zetten (letterlijk in hun install-script; de test
// TestTemplatesReadyPage houdt ze gelijk).
//
//go:embed pages/*.html
var pagesFS embed.FS

// Page geeft de HTML van een standaardpagina ("installing", "offline", "disk",
// "unavailable" of "ready").
func Page(name string) (string, error) {
	b, err := pagesFS.ReadFile("pages/" + name + ".html")
	if err != nil {
		return "", fmt.Errorf("proxy: geen standaardpagina %q", name)
	}
	return string(b), nil
}

func placeholderPage(p Placeholder) (string, error) {
	switch p {
	case PlaceholderInstalling, PlaceholderOffline, PlaceholderDisk, PlaceholderUnavailable:
		return Page(string(p))
	}
	return "", fmt.Errorf("proxy: onbekende Placeholder %q", p)
}

// placeholderHandler is de Caddy-handler die de pagina met status 503 serveert.
func placeholderHandler(p Placeholder) (map[string]any, error) {
	body, err := placeholderPage(p)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"handler":     "static_response",
		"status_code": 503,
		"headers": map[string][]string{
			"Content-Type":  {"text/html; charset=utf-8"},
			"Retry-After":   {"30"},
			"Cache-Control": {"no-store"},
		},
		"body": body,
	}, nil
}
