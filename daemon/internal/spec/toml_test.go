package spec

import "testing"

const velocity = `# Velocity
config-version = "2.7"
bind = "0.0.0.0:25577" # luisteradres
show-max-players = 500
online-mode = true
player-info-forwarding-mode = "NONE"

[servers]
# servers
lobby = "127.0.0.1:30066"
try = [
  "lobby"
]

[forced-hosts]
"lobby.example.com" = [
    "lobby"
]

[advanced]
compression-threshold = 256

[[extra]]
bind = "niet aanraken"
`

func TestUpdateTOML(t *testing.T) {
	got := string(UpdateTOML([]byte(velocity), map[string]string{
		"bind":                           "0.0.0.0:{{X}}",
		"show-max-players":               "100",
		"online-mode":                    "false",
		"player-info-forwarding-mode":    "modern",
		"config-version":                 "3",
		"servers.lobby":                  "127.0.0.1:25566",
		"servers.try":                    `["lobby", "survival"]`,
		"servers.survival":               "127.0.0.1:25567",
		"advanced.compression-threshold": "abc",
		"advanced.nieuw.diep":            "1",
		"motd":                           "Hallo",
		"query.port":                     "25577",
		"query.enabled":                  "true",
	}))
	want := `# Velocity
config-version = "3"
bind = "0.0.0.0:{{X}}" # luisteradres
show-max-players = 100
online-mode = false
player-info-forwarding-mode = "modern"
motd = "Hallo"

[servers]
# servers
lobby = "127.0.0.1:25566"
try = ["lobby", "survival"]
survival = "127.0.0.1:25567"

[forced-hosts]
"lobby.example.com" = [
    "lobby"
]

[advanced]
compression-threshold = "abc"
nieuw.diep = 1

[[extra]]
bind = "niet aanraken"

[query]
enabled = true
port = 25577
`
	if got != want {
		t.Fatalf("kreeg:\n%s\nwil:\n%s", got, want)
	}
	// Idempotent.
	if again := string(UpdateTOML([]byte(got), map[string]string{"servers.lobby": "127.0.0.1:25566"})); again != got {
		t.Fatalf("niet idempotent:\n%s", again)
	}
	if got := string(UpdateTOML(nil, map[string]string{"a": "x", "b.c": "2"})); got != "a = \"x\"\n\n[b]\nc = 2\n" {
		t.Fatalf("leeg bestand: %q", got)
	}
}
