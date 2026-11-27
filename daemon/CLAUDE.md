# daemon — Go node-daemon

Eigen map: `daemon/` behalve `daemon/proxy/` (web-hosting). Contract: `packages/api/openapi.yaml`
(daemon-API + websocket), `packages/api/panel-remote.yaml` (wat jij bij het panel aanroept),
`daemon/proxy/router.go` (Caddy-koppeling), `templates/SCHEMA.md`. Lees ook de root-`CLAUDE.md`.

Module `panel/daemon`, binary `cmd/panel-daemon`. Toegestane dependencies o.a.:
`github.com/docker/docker/client` (of `github.com/moby/moby/client`), `gorilla/websocket`,
`golang-jwt/jwt/v5`, `pkg/sftp`, `golang.org/x/crypto/ssh`, `klauspost/compress/zstd`.

## Configuratie (env, zie `deploy/panel.env.example`)

`NODE_TOKEN`, `NODE_DOMAIN`, `PANEL_URL` (leeg → `https://$PANEL_DOMAIN`), `DAEMON_SOCKET`,
`DAEMON_PORT`, `SFTP_PORT`, `DATA_DIR`, `CADDY_ADMIN_URL` (leeg → `proxy.NewFake()`),
`CADDY_CONTAINER`, `CADDY_TLS_ADDR`, `PANEL_INSTANCE`, `DOCKER_EXTRA_LABELS` (`k=v,k2=v2`), `DOCKER_NETWORK_POOL` (standaard `10.213.0.0/16`; /28 per server, /26 per Velocity-netwerk; `docker` = Docker kiest).

## Fase 1 — taak

1. **HTTP-server** op unix-socket `DAEMON_SOCKET` (map aanmaken, rechten 0660) én
   `127.0.0.1:$DAEMON_PORT`. Verwijder een bestaand (oud) socketbestand vóór `listen`
   (systemd bewaart `/run/panel` tussen herstarts). Alle endpoints uit `openapi.yaml` die in fase 1 vallen:
   `/api/system`, `/api/servers` (GET/POST), `/api/servers/{uuid}` (GET/PUT/DELETE),
   `/install`, `/power`, `/commands`, `/logs`, `/stats`, `/ws`, en `/api/routes*` (opslaan +
   doorgeven aan de Router). Files/backups: 501 met `{"error":"not_implemented"}`.
   Bearer-token in constante tijd vergelijken. Fouten als `Error`-schema.
2. **Containers** via de Docker SDK. Naam `panel-<uuid>`. Labels: `panel.managed=true`,
   `panel.instance`, `panel.server_uuid`, plus `DOCKER_EXTRA_LABELS`. Data:
   `$DATA_DIR/volumes/<uuid>` → `/home/container` (bind mount, eigenaar 1000:1000).
   Draai als `User: 1000:1000`, `CapDrop: ALL`, `SecurityOpt: no-new-privileges`,
   PID-limiet (`limits.pids`, standaard 512), geheugen + swap, CPU-quota (`cpu_pct`),
   read-only rootfs met tmpfs op `/tmp`. Poorten: elke allocation tcp + udp op `ip:port`.
   Env: `environment` + ingebouwde variabelen (zie `ServerSpec` in openapi). `{{VAR}}`
   vervangen in `startup` en `config_files` (properties/yaml/json bijwerken vóór elke start).
   Start met `/bin/sh -c "<startup>"`, `WorkingDir /home/container`, stdin open, geen tty.
3. **Installatie**: tijdelijke container (zelfde labels + `panel.role=install`) met
   `install.image`, script via `/bin/sh`, als root, met netwerk, zelfde mount. Output als
   `install_output` naar websockets. Daarna `chown -R 1000:1000`. Resultaat naar
   `POST {PANEL_URL}/api/remote/servers/{uuid}/install`; bij `start_on_install` direct starten.
4. **Power en status**: `start/stop/restart/kill`. Stop = `stop`-commando naar stdin of
   signaal; na 30 s kill. Status: `starting` tot de eerste regel die `ready_pattern` matcht,
   dan `online`; exit → `offline`. Elke wijziging als `status` naar websockets en (best effort)
   `POST /api/remote/servers/{uuid}/status`.
5. **Console**: stdout/stderr per regel, ring buffer van 500 regels per server.
   `send_command` schrijft naar stdin.
6. **Websocket** precies volgens `openapi.yaml`: eerste bericht `auth` binnen 10 s, JWT
   (EdDSA) controleren met de JWKS van `GET {PANEL_URL}/api/remote/jwt-key` (cachen; opnieuw
   ophalen bij onbekende `kid`), `aud == NODE_DOMAIN`, `server_uuid` == pad. Daarna
   `auth_success`, de backlog, en de huidige `status`. `token_expiring` 60 s voor `exp`; bij
   verlopen `token_expired` en sluiten met 4001. Rechten per bericht controleren
   (`console.read` om te verbinden, `console.write`, `power`). Origin-check: alleen
   `https://$PANEL_DOMAIN` (en geen Origin, voor niet-browsers).
7. **Stats** elke 2 s (Docker stats-stream): cpu_pct (100 = één core), geheugen, netwerk;
   `disk_bytes` uit een mapmeting (efficiënte walk) elke minuut, verspreid over de minuut.
   De volledige softe disk-limiet is fase 2, maar meet nu al.
8. **Herstart-veilig**: specs staan in `$DATA_DIR/state/servers/<uuid>.json`, routes in
   `$DATA_DIR/state/routes.json` (atomisch schrijven). Bij de start: Docker-containers met
   onze labels opzoeken, weer aan stdout/stdin koppelen, backlog vullen uit de laatste 500
   logregels, en `online` zetten als het ready-patroon sinds de containerstart in de log staat.
   **Stop nooit containers als de daemon zelf stopt.** Daarna `Router.Sync` met alle routes,
   en `POST /api/remote/node/hello` (versie + `disk_quota_mode`).
9. **Router**: `proxy.NewCaddy(proxy.Config{...})` als `CADDY_ADMIN_URL` gezet is, anders
   `proxy.NewFake()`. Sync bij de start, elke 5 minuten, en via `proxy.HealthChecker` na een
   Caddy-herstart.

**Tests**: unit-tests met fakes (Docker-interface achter een eigen interface zodat je hem kunt
faken; Router met `proxy.NewFake()`; panel met `httptest`). Daarnaast tests tegen echte Docker
met `alpine`-containers (label `panel.test=true` + eigen `panel.instance`), die een "ready"-regel
printen en stdin echoën. Geen Minecraft in je eigen tests nodig; dat doet de integratietest
(`tests/integration/phase1.test.ts`) — lees die, want daar moet je aan voldoen.

**Klaar als**: `make check` groen, alle fase-1-endpoints gedekt door tests, en de flow
installeren → starten → console → commando → stop → daemon-herstart → console werkt
aantoonbaar met een alpine-testcontainer.

## Fase 2
Bestands-API (pad-ontsnapping onmogelijk, ook via symlinks), upload/download met eenmalige JWT,
CORS voor `https://$PANEL_DOMAIN`, SFTP op `SFTP_PORT` met auth via `/api/remote/sftp/auth`,
softe disk-limiet (90%-waarschuwing als `daemon_message`, weigeren met 507, server stoppen,
starten weigeren met `disk_exceeded`), 5%-vrije-schijf-bewaking, XFS-prjquota-detectie,
CPU/RAM/PID-limieten live bijwerken bij PUT.

## Fase 3
Eigen intern netwerk per site (`panel-site-<uuid>`, `internal: true`, labels), MariaDB-netwerk
koppelen voor sites met database, SSL-status uit de Router doorgeven in `/api/routes`.

## Fase 4
Backups: `tar.zst` streamen naar S3 met SHA-256 tijdens het streamen, `mariadb-dump` in een
tijdelijke container onder `_databases/`, `backup_progress`. Herstel volgens de stappen in het
ontwerp; faalt iets vóór stap 4, dan blijft de oude data heel.
