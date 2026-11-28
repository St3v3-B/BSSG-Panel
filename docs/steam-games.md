# Steam games and Terraria

Besides Minecraft the panel ships templates for Steam dedicated servers, installed with SteamCMD, and for
Terraria (the official server from terraria.org). Console, power controls, backups, disk quota and limits work
as for every other server. Sleep mode, the Players tab, Bedrock and plugins/mods are Minecraft-only and are
not shown for these servers.

| Template | Steam app | Runtime image | Recommended RAM | Recommended disk |
|---|---|---|---|---|
| `valheim` | 896660 | `ghcr.io/ptero-eggs/games:valheim` | 4 GB | 4 GB |
| `satisfactory` | 1690800 | `ghcr.io/ptero-eggs/steamcmd:debian` | 12 GB (min. 8 GB) | 15 GB |
| `palworld` | 2394010 | `ghcr.io/ptero-eggs/steamcmd:debian` | 8 GB (16 GB for >10 players) | 12 GB |
| `rust` | 258550 | `ghcr.io/ptero-eggs/steamcmd:debian` | 12 GB (min. 8 GB) | 20 GB |
| `cs2` | 730 | `ghcr.io/ptero-eggs/steamcmd:sniper` (Steam Runtime 3) | 4 GB | **60 GB** (the game is ~35 GB) |
| `terraria` | - | `debian:12-slim` | 1 GB (2 GB for large worlds) | 2 GB |

The admin create form shows these recommendations and fills them in with **Use recommended limits**.

## Ports and firewall

Steam games use UDP. Every allocation has a protocol (TCP, UDP or both; **both** is the default and what every
existing allocation keeps). A template that describes its ports (`ports` in [`templates/SCHEMA.md`](../templates/SCHEMA.md))
decides the protocol of the allocations it uses, so you do not have to create UDP-only allocations for these
games. The first allocation is the game port; give a server one allocation per port in the table below
(the create form lists them in order). In self-service (quotas) and plans the panel picks consecutive ports
where possible and always at least the required ones.

| Game | Port (default) | Protocol | Notes |
|---|---|---|---|
| Valheim | game (2456) | UDP | |
| | Steam query (game + 1, 2457) | UDP | must be exactly game + 1; without it the server only works via direct connect / join code |
| Satisfactory | game (7777) | UDP + TCP | UDP for the game, TCP for the server API |
| | reliable port (8888) | TCP | **required**: the panel refuses to create the server without a second allocation |
| Palworld | game (8211) | UDP | |
| | RCON (game + 1) | TCP | optional; set `RCON_ENABLED=True` and an admin password |
| Rust | game (28015) | UDP | |
| | RCON (game + 1) | TCP | optional, WebRCON with `RCON_PASSWORD` |
| | Steam query (game + 2) | UDP | needed for the server browser |
| | Rust+ app (game + 67, 28082) | TCP | optional |
| Counter-Strike 2 | game (27015) | UDP + TCP | TCP for RCON |
| | SourceTV (game + 5) | UDP | optional |
| Terraria | game (7777) | TCP | |

Docker publishes exactly these protocols on the IP of the allocation. On the host firewall (and the router or
cloud security group in front of it) open the same ports with the same protocol, for example with ufw:

```
ufw allow 2456:2457/udp        # Valheim
ufw allow 7777/tcp && ufw allow 7777/udp && ufw allow 8888/tcp   # Satisfactory
ufw allow 8211/udp             # Palworld
ufw allow 28015/udp && ufw allow 28017/udp && ufw allow 28016/tcp   # Rust (+ 28082/tcp for Rust+)
ufw allow 27015/udp && ufw allow 27015/tcp   # CS2
ufw allow 7777/tcp             # Terraria
```

Note that Docker-published ports bypass ufw's `INPUT` rules on many setups (Docker writes its own iptables
rules); a cloud firewall or router still needs them. Ports that a template describes but that have no allocation
are not published at all: the game can listen on them inside the container, nobody can reach them from outside.

## Installing and updating

The install script runs in a temporary container (`steamcmd/steamcmd:debian-12`, as root, with network) and runs
`steamcmd +force_install_dir /home/container +login anonymous +app_update <app> validate +quit` (three attempts).
Then it copies `steamclient.so` to `.steam/sdk64` in the server directory, where the games look for it.
The server itself runs as uid 1000 with a read-only root filesystem, no capabilities and `HOME=/home/container`,
like every other server.

**Updating = reinstall.** SteamCMD downloads the new version and `validate` only checks the game's own files:
worlds, saves and configuration files are not part of the game depot and stay. Where they live:

- Valheim: `saves/` (worlds in `saves/worlds_local`)
- Satisfactory: `.config/Epic/FactoryGame/Saved/SaveGames`
- Palworld: `Pal/Saved` (world and `PalWorldSettings.ini`)
- Rust: `server/rust` (map, saves, `cfg/`)
- CS2: your own files in `game/csgo/cfg` (files that ship with the game, such as `gameinfo.gi`, are restored by `validate`)
- Terraria: `worlds/`

The first CS2 installation downloads about 35 GB and can take a long time; its install timeout is 6 hours (the
other games 1-2 hours, see `install.timeout_minutes`). Make a backup before a major game update anyway.

## Per game

- **Valheim**: the password must be at least 5 characters and must not contain the server name (Valheim refuses
  to start otherwise; the panel checks the length). `PUBLIC=0` hides the server from the community list.
  Stop = SIGINT: Valheim saves the world first.
- **Satisfactory**: name, admin password and join password are set in the game: connect via Server Manager and
  claim the server. `MAX_PLAYERS` sets the player limit.
- **Palworld**: the variables (name, description, passwords, max players, RCON) are written into
  `PalWorldSettings.ini` on every start; other options can be edited in that file (stop the server first).
  If the file is missing, the panel copies `DefaultPalWorldSettings.ini`.
- **Rust**: a different `SEED` or `WORLD_SIZE` creates a new map (a wipe). The console shows the server log;
  for full remote administration use WebRCON on the RCON port. Stop = SIGINT (Rust saves first; the panel waits
  up to 3 minutes before killing).
- **Counter-Strike 2**: for internet listing create a Game Server Login Token for app 730 at
  <https://steamcommunity.com/dev/managegameservers> and set it in `STEAM_GSLT`. `GAME_TYPE`/`GAME_MODE`:
  0/1 competitive, 0/0 casual, 0/2 wingman, 1/0 arms race, 1/2 deathmatch. Stop = `quit` in the console.
- **Terraria**: the world is created on the first start with `WORLD_SIZE`, `DIFFICULTY` and `WORLD_SEED`;
  later changes to these only apply to a new `WORLD_NAME`. `exit` (or Stop) saves the world.

All text variables (names, passwords, descriptions) are passed to the game through environment variables, never
pasted into the start command, and are restricted to a safe set of characters.
