# Minecraft

## Templates

| Template | Notes |
|---|---|
| **Paper** | PaperMC with SHA-256 verification, Velocity forwarding variables, sleep mode |
| **Folia** | Paper's regionised multithreading fork, same variables |
| **Fabric** | Fabric meta API, Minecraft and loader version as variables, sleep mode |
| **Velocity** | Proxy with modern forwarding and a generated secret |
| **Generic Java** | Any JAR on Java 8, 11, 17, 21 or 25 (Temurin, checksum-verified) |

The Java heap is sized as the memory limit minus the larger of 25% and 512 MB, with direct memory and code cache capped,
so the JVM's off-heap use does not get the container killed. Give Paper, Folia and Fabric 1.5 GB or more.

Change the Minecraft version on the **Settings** tab (variables) and reinstall. A version picker lists the available builds.

## Sleep mode

Enable it per server under **Settings** and choose the idle time (1 to 1440 minutes).

1. Every minute the daemon pings the server with the Minecraft status protocol to count players.
2. After the idle time with nobody online, it stops the server cleanly and the status becomes `sleeping`.
3. The daemon listens on the server's port itself. The server list shows a sleeping message, and a login attempt starts the server and
   asks the player to reconnect in a minute.

Stopping a server by hand means off: it does not wake up on its own. Sleep mode needs a template that supports it (Paper, Folia, Fabric).

## Plugins, mods and modpacks

The **Plugins** tab (Paper, Folia, Velocity) or **Mods** tab (Fabric) searches Modrinth and, for plugins, Hangar. It filters by your
server's Minecraft version and loader, installs into the right folder, shows which items have updates and lets you update or
uninstall them. On Fabric you can also import a modpack from Modrinth.

## Velocity network

Create a **Velocity** server and open its **Network** tab. It lists your Paper, Folia and Fabric servers on the same node as possible
backends. When you add them the panel sets everything up in one go:

- the forwarding secret, shared between the proxy and the backends,
- the `[servers]` and `try` sections of `velocity.toml`,
- `VELOCITY_FORWARDING` and `VELOCITY_SECRET` on every backend, and `online-mode` off while forwarding is on.

Removing a backend from the network switches its forwarding off again. Fabric backends use FabricProxy-Lite. Players connect to the proxy's address.
When a server moves to another node, the proxy's config is updated, and the proxy needs a restart.

**Forced hosts**: in the same tab you can send players to a specific backend based on the address they type, for example
`survival.example.com` to the survival server (written to `[forced-hosts]` in `velocity.toml`; everyone else follows `try`). Minecraft
domains attached to the proxy or its backends are offered as suggestions. Point each of these domains at the proxy (A record to the node,
SRV to the proxy port); for a domain attached to a backend the panel's SRV check uses the proxy port automatically. The panel owns
`[forced-hosts]`: entries you add there by hand are replaced when you save the network.

Manual setup, if you prefer: set `VELOCITY_FORWARDING=true` and `VELOCITY_SECRET=<secret>` on each Paper server and add the backends to
`velocity.toml` yourself. See also [`deploy/README.md`](../deploy/README.md).

## Bedrock players (Geyser and Floodgate)

The **Bedrock** tab on Paper, Folia, Fabric and Velocity servers lets Bedrock Edition players join. The panel installs Geyser, writes its config and, on a Velocity
network, installs Floodgate and distributes its key to the backends. On Fabric it installs Geyser-Fabric and Floodgate-Fabric from Modrinth for the
server's Minecraft version (plus Fabric API when it is missing; it stays when you turn Bedrock off); Fabric backends behind a proxy get Floodgate-Fabric. Bedrock uses a UDP port, so you need a free allocation for it.
Geyser can share the UDP port of the Java port (RakNet) or use its own, depending on the transport you choose.

## Players

The **Players** tab shows who is online (refreshed every 10 seconds) and lets you manage the whitelist, operators and bans, and kick
players. While the server runs the panel uses console commands (`whitelist add`, `op`, `ban`, ...); while it is stopped it edits
`whitelist.json`, `ops.json`, `banned-players.json` and `banned-ips.json` directly, so changes apply on the next start. Player names
are validated strictly. Bedrock players (Floodgate prefix `.`) can be added when Floodgate is installed. On a Velocity proxy the tab
shows who is on which backend; whitelists and bans are managed on the backends. Plugins that replace `/list` (for example Essentials)
can hide the player names; the count is still shown.

## Player activity

The **Activity** tab (permission to view players) shows who is online now, a timeline per player for a day or a week with
markers for server start, stop, crash, sleep and wake, a heatmap of peak hours (average players per weekday and hour over four
weeks, Europe/Amsterdam) and a table with playtime, sessions and last seen. Data is kept for 90 days.

- The daemon reads join and leave lines from the console with the `player_events` patterns of the template (built in for
  Minecraft and Velocity; see `templates/SCHEMA.md`). The patterns cover the whole line and need the player name right after the
  log prefix, so chat such as `<Griefer> Steve joined the game` is ignored. When the server stops, crashes or goes to sleep, the
  daemon reports it and open sessions are closed with that reason.
- Safety net: if the daemon missed something (for example while it was restarting), the panel closes sessions of servers that are
  no longer running and compares a server-list ping every 5 minutes with the open sessions.
- Velocity records connecting to and leaving the proxy, not switching between backend servers.

## Domains for game servers

If an admin allows it for a server, you can attach a domain to a game server. Choose the `minecraft` protocol to get a SRV record so players
can connect without typing a port, or the `http` protocol to expose a web port (for example a dynmap) through Caddy.

## Crash handling

The daemon records exit code, out-of-memory kills and crash reports. It restarts a crashed server with exponential backoff and gives up after a limit.
The result is part of the notification.
