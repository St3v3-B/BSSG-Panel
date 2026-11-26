package proxy

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestPages(t *testing.T) {
	style := regexp.MustCompile(`(?s)<style>.*</style>`)
	ready, err := Page("ready")
	if err != nil {
		t.Fatal(err)
	}
	css := style.FindString(ready)
	for _, p := range []Placeholder{PlaceholderInstalling, PlaceholderOffline, PlaceholderDisk, PlaceholderUnavailable} {
		b, err := placeholderPage(p)
		if err != nil {
			t.Fatal(err)
		}
		if style.FindString(b) != css || !strings.Contains(b, `<div class="host">{http.request.host}</div>`) || !strings.Contains(b, `lang="nl"`) {
			t.Errorf("%s: ander ontwerp of geen hostnaam", p)
		}
		if strings.Contains(b, "http://") || strings.Contains(b, "https://") {
			t.Errorf("%s: externe bronnen", p)
		}
	}
	if _, err := placeholderPage("bestaat-niet"); err == nil {
		t.Error("onbekende placeholder geaccepteerd")
	}
	if _, err := normRoute(Route{Host: "a.test", Placeholder: "raar"}); err == nil {
		t.Error("onbekende Placeholder in een route geaccepteerd")
	}
	if _, err := normRoute(Route{Host: "a.test", Placeholder: PlaceholderOffline}); err != nil {
		t.Errorf("placeholder zonder upstream: %v", err)
	}
}

// De webtemplates zetten pages/ready.html letterlijk in een lege public/.
func TestTemplatesReadyPage(t *testing.T) {
	ready, _ := Page("ready")
	files, _ := filepath.Glob("../../templates/web/*.yaml")
	n := 0
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var tpl struct {
			Install struct{ Script string } `yaml:"install"`
		}
		if err := yaml.Unmarshal(b, &tpl); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(tpl.Install.Script, "public/index.html") {
			continue // bv. adminer
		}
		n++
		if !strings.Contains(tpl.Install.Script, "<<'EOF'\n"+ready+"EOF\n") {
			t.Errorf("%s: index.html in het install-script wijkt af van pages/ready.html", filepath.Base(f))
		}
	}
	if n < 5 {
		t.Errorf("maar %d templates met index.html", n)
	}
}
