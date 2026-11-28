# Template format

A template is a single YAML file: `templates/game/<slug>.yaml` or `templates/web/<slug>.yaml`.
The zod schema lives in `packages/api/template-schema.ts` (owner: orchestrator); the test in
`packages/api/contract.test.ts` validates every file in `templates/game/` and `templates/web/`.

On every start the panel loads all templates from these directories (`TEMPLATES_DIR`, in the image
`/app/templates`) and updates a template in the database when its `version` is higher than the
stored version. Admins can also import or edit templates in /admin.

## Fields

| Field | Required | Meaning |
|---|---|---|
| `schema` | yes | always `1` |
| `slug` | yes | unique key, `a-z0-9-` (no dot; the file name may differ, e.g. `php-8.3.yaml` with slug `php-8-3`) |
| `name`, `description` | name: yes | display name and explanation |
| `type` | yes | `game` or `web` |
| `version` | yes | integer; bump on every change |
| `image` | yes | runtime image, must be able to run as non-root (uid 1000) |
| `startup` | yes | start command, run with `/bin/sh -c` in `/home/container` |
| `stop` | yes | `{type: command, value: stop}` or `{type: signal, value: SIGTERM}` |
| `ready_pattern` | yes | RE2 regex on stdout; first match sets status to *online* |
| `http_port` | web only | port in the container where Caddy delivers the traffic |
| `variables` | no | list of `{key, name, description?, default, user_editable, pattern?}` |
| `install` | yes | `{image, script}`; the script runs with `/bin/sh` and the same `/home/container` |
| `image_version_env` | no | name of an env variable in the image config (e.g. `PHP_VERSION`) whose major.minor must stay the same for an automatic image update; if it differs the server needs a reinstall and the daemon only reports it |
| `player_events` | no | player activity (Activity tab): `minecraft` or `velocity` (built-in patterns), `none`, or your own `{join, leave, uuid?}` (see below). Default: `minecraft` for Paper/Folia/Fabric/vanilla/generic Java, `velocity` for Velocity, otherwise none |
| `config_files` | no | files the daemon updates before every start; `format`: properties, yaml, json or toml (keys with dots are nested) |

## Variables

- `{{KEY}}` in `startup` and in `config_files[].set` is replaced by the value.
- All variables are also set as environment variables in the container and in the install script.
- Built in (do not define yourself): `SERVER_UUID`, `SERVER_MEMORY` (MB, = RAM limit),
  `SERVER_IP`, `SERVER_PORT` (primary allocation), `TZ` (`Europe/Amsterdam`).
- `pattern` is a regex that must match the whole value; the panel checks it on save.
- `user_editable: false` means only an admin can set the value.

## Player events

The daemon matches every console line (colour codes stripped) against these RE2 patterns and reports joins and
leaves to the panel. `join` and `leave` need a named group `(?<name>…)`; `uuid` (optional, a line logged before
the join) needs `(?<name>…)` and `(?<uuid>…)`. Anchor patterns to the whole line (`^…$`) and require the name right
after the log prefix, so chat that imitates a join (`<Griefer> Steve joined the game`) never matches. The presets
live in `packages/api/player-activity.ts`. Example for another game:

```yml
player_events:
  join: '^\[\d{2}:\d{2}:\d{2}\] Player (?<name>[A-Za-z0-9_]{1,32}) connected$'
  leave: '^\[\d{2}:\d{2}:\d{2}\] Player (?<name>[A-Za-z0-9_]{1,32}) disconnected$'
```

## Values in config_files

For yaml, json and toml the daemon writes `true`, `false` and numbers bare; everything else as a
string. An existing key keeps its type. Keys with dots go into the nested table/map
(`proxies.velocity.secret`, in toml under `[proxies.velocity]`).

## Container rules (enforced by the daemon, not by the template)

An init process (PID 1, forwards signals), non-root, not privileged, all capabilities dropped, `no-new-privileges`, PID limit, label
`panel.managed=true`. The server data lives in `/home/container`; install everything there.
The install script runs as root in a temporary container (with network), after which the
daemon sets the owner of `/home/container` to uid 1000.

## Example

```yaml
schema: 1
slug: java-generic
name: Generic Java
description: Runs your own JAR with the chosen Java version.
type: game
version: 1
image: eclipse-temurin:21-jre
startup: java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{JAR_FILE}}
stop:
  type: command
  value: stop
ready_pattern: "Done \\("
variables:
  - key: JAR_FILE
    name: JAR file
    description: Name of the JAR in the root directory
    default: server.jar
    user_editable: true
    pattern: "^[A-Za-z0-9._-]+\\.jar$"
install:
  image: alpine:3.20
  script: |
    #!/bin/sh
    set -e
    cd /home/container
    echo "Put $JAR_FILE here via SFTP or the file manager." > README.txt
config_files: []
```
