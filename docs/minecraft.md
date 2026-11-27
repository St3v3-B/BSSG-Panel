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

Manual setup, if you prefer: set `VELOCITY_FORWARDING=true` and `VELOCITY_SECRET=<secret>` on each Paper server and add the backends to
`velocity.toml` yourself. See also [`deploy/README.md`](../deploy/README.md).

## Bedrock players (Geyser and Floodgate)

The **Bedrock** tab on Paper, Folia and Velocity servers lets Bedrock Edition players join. The panel installs Geyser, writes its config and, on a Velocity
network, installs Floodgate and distributes its key to the backends. Bedrock uses a UDP port, so you need a free allocation for it.
Geyser can share the UDP port of the Java port (RakNet) or use its own, depending on the transport you choose.

## Domains for game servers

If an admin allows it for a server, you can attach a domain to a game server. Choose the `minecraft` protocol to get a SRV record so players
can connect without typing a port, or the `http` protocol to expose a web port (for example a dynmap) through Caddy.

## Crash handling

The daemon records exit code, out-of-memory kills and crash reports. It restarts a crashed server with exponential backoff and gives up after a limit.
The result is part of the notification.
