package server

import (
	"testing"

	"panel/daemon/internal/spec"
)

// Dezelfde patronen als de presets in packages/api/player-activity.ts (een TS-test bewaakt dat ze gelijk blijven).
const (
	mcJoin   = `^(?:\[[^\]]+\] \[Server thread/INFO\](?: \[[^\]]+\]| \([^)]+\))?:? |\[\d{2}:\d{2}:\d{2} INFO\]: )(?<name>\.?[A-Za-z0-9_]{1,16}) joined the game$`
	mcLeave  = `^(?:\[[^\]]+\] \[Server thread/INFO\](?: \[[^\]]+\]| \([^)]+\))?:? |\[\d{2}:\d{2}:\d{2} INFO\]: )(?<name>\.?[A-Za-z0-9_]{1,16}) left the game$`
	mcUUID   = `^(?:\[[^\]]+\] \[[^\]/]+/INFO\](?: \[[^\]]+\]| \([^)]+\))?:? |\[\d{2}:\d{2}:\d{2} INFO\]: )UUID of player (?<name>\.?[A-Za-z0-9_]{1,16}) is (?<uuid>[0-9a-fA-F-]{32,36})$`
	velJoin  = `^\[\d{2}:\d{2}:\d{2} INFO\]: \[connected player\] (?<name>\.?[A-Za-z0-9_]{1,16}) \([^)]*\) has connected$`
	velLeave = `^\[\d{2}:\d{2}:\d{2} INFO\]: \[connected player\] (?<name>\.?[A-Za-z0-9_]{1,16}) \([^)]*\) has disconnected$`
)

func TestPlayerMatcherMinecraft(t *testing.T) {
	m := CompilePlayerEvents(&spec.PlayerEvents{Join: mcJoin, Leave: mcLeave, UUID: mcUUID})
	if m == nil {
		t.Fatal("patronen compileren niet")
	}
	cases := []struct {
		line, kind, name, uuid string
	}{
		// vanilla / Fabric (Server thread)
		{"[12:34:56] [Server thread/INFO]: Steve joined the game", "join", "Steve", ""},
		{"[12:34:56] [Server thread/INFO]: Steve left the game", "leave", "Steve", ""},
		{"[12:34:56] [User Authenticator #1/INFO]: UUID of player Steve is 069a79f4-44e9-4726-a5be-fca90e38aaf5", "uuid", "Steve", "069a79f4-44e9-4726-a5be-fca90e38aaf5"},
		// Fabric met loggernaam, Forge/NeoForge met [logger]
		{"[12:34:56] [Server thread/INFO] (Minecraft) Alex joined the game", "join", "Alex", ""},
		{"[28Nov2026 12:34:56.789] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: Alex left the game", "leave", "Alex", ""},
		// Paper / Folia
		{"[12:34:56 INFO]: Steve joined the game", "join", "Steve", ""},
		{"\x1b[33m[12:34:56 INFO]: Steve left the game\x1b[0m", "leave", "Steve", ""},
		{"[12:34:56 INFO]: UUID of player Alex is 61699B2E-D327-4A01-9F1E-0EA8C3F06BC6", "uuid", "Alex", "61699b2e-d327-4a01-9f1e-0ea8c3f06bc6"},
		// Bedrock via Floodgate
		{"[12:34:56 INFO]: .PocketKid joined the game", "join", ".PocketKid", ""},
		// chat die een join nabootst: genegeerd
		{"[12:34:56] [Server thread/INFO]: <Griefer> Steve joined the game", "", "", ""},
		{"[12:34:56 INFO]: <Griefer> Steve joined the game", "", "", ""},
		{"[12:34:56 INFO]: [Not Secure] <Griefer> Steve left the game", "", "", ""},
		{"[12:34:56] [Async Chat Thread - #0/INFO]: <Griefer> Steve joined the game", "", "", ""},
		{"[12:34:56] [Server thread/INFO]: * Griefer Steve joined the game", "", "", ""},
		{"[12:34:56] [Server thread/INFO]: [Griefer] Steve joined the game", "", "", ""},
		{"[12:34:56 INFO]: Griefer: Steve joined the game", "", "", ""},
		{"[12:34:56 INFO]: <Griefer> UUID of player Steve is 069a79f4-44e9-4726-a5be-fca90e38aaf5", "", "", ""},
		{"Steve joined the game", "", "", ""},
		// andere threads en niveaus tellen niet voor join/leave
		{"[12:34:56] [Worker-1/INFO]: Steve joined the game", "", "", ""},
		{"[12:34:56 WARN]: Steve joined the game", "", "", ""},
		// te lange naam, rommel achteraan
		{"[12:34:56 INFO]: ABCDEFGHIJKLMNOPQ joined the game", "", "", ""},
		{"[12:34:56 INFO]: Steve joined the game!", "", "", ""},
		{"[12:34:56 INFO]: UUID of player Steve is not-a-uuid-but-long-enough-xxxxxxxx", "", "", ""},
	}
	for _, c := range cases {
		k, n, u := m.Match(c.line)
		if k != c.kind || n != c.name || u != c.uuid {
			t.Errorf("%q: kreeg (%q,%q,%q), verwacht (%q,%q,%q)", c.line, k, n, u, c.kind, c.name, c.uuid)
		}
	}
}

func TestPlayerMatcherVelocity(t *testing.T) {
	m := CompilePlayerEvents(&spec.PlayerEvents{Join: velJoin, Leave: velLeave})
	cases := []struct{ line, kind, name string }{
		{"[12:34:56 INFO]: [connected player] Steve (/203.0.113.7:51234) has connected", "join", "Steve"},
		{"[12:34:56 INFO]: [connected player] Steve (/203.0.113.7:51234) has disconnected", "leave", "Steve"},
		{"[12:34:56 INFO]: [server connection] Steve -> lobby has connected", "", ""},
		{"[12:34:56 INFO]: <Steve> [connected player] Alex (/1.2.3.4:1) has connected", "", ""},
	}
	for _, c := range cases {
		k, n, _ := m.Match(c.line)
		if k != c.kind || n != c.name {
			t.Errorf("%q: kreeg (%q,%q)", c.line, k, n)
		}
	}
}

func TestCompilePlayerEventsInvalid(t *testing.T) {
	for _, pe := range []*spec.PlayerEvents{
		nil,
		{Join: mcJoin},
		{Join: `^(\w+) joined$`, Leave: mcLeave},
		{Join: `(`, Leave: mcLeave},
	} {
		if CompilePlayerEvents(pe) != nil {
			t.Errorf("%+v: verwacht nil", pe)
		}
	}
	// ongeldig uuid-patroon: join/leave werken, uuid niet
	m := CompilePlayerEvents(&spec.PlayerEvents{Join: mcJoin, Leave: mcLeave, UUID: `^(?<name>\w+)$`})
	if m == nil || m.uuid != nil {
		t.Fatal("uuid-patroon zonder uuid-groep hoort genegeerd te worden")
	}
	var nilM *PlayerMatcher
	if k, _, _ := nilM.Match("[12:34:56 INFO]: Steve joined the game"); k != "" {
		t.Fatal("nil-matcher")
	}
}
