# web-hosting — Caddy-koppeling en webtemplates

Eigen mappen: `daemon/proxy/` (behalve `router.go`, `fake.go`, `fake_test.go`: die zijn van de
orchestrator), `templates/web/`, `deploy/caddy/`. Lees de root-`CLAUDE.md`.

Contract: de interfaces `Router` en `HealthChecker` en `Config` in `router.go`. De daemon roept
`NewCaddy(cfg)` aan (stub in `caddy.go`, die vervang jij). De daemon is de bron van waarheid:
hij bewaart de routes en roept `Sync` aan; jij bewaart niets blijvends.

## Fase 1 — taak

1. **Caddy-basisconfig** in `deploy/caddy/`: een Caddyfile met `{$PANEL_DOMAIN}` en
   `{$NODE_DOMAIN}` (niet per installatie aanpassen), `email {$ACME_EMAIL}`, admin op
   `0.0.0.0:2019` binnen de container (templates-ops publiceert hem alleen op
   `127.0.0.1:2019`). Routes:
   - `{$PANEL_DOMAIN}` → `reverse_proxy panel:3000` (compose-service `panel`)
   - `{$NODE_DOMAIN}` → `reverse_proxy unix//run/panel/daemon.sock` (websockets moeten werken;
     `/run/panel` wordt in de Caddy-container gemount)
   - HTTP → HTTPS, en een duidelijke plek waar de dynamische routes landen.
   Leg in `deploy/caddy/README.md` uit hoe templates-ops hem in docker-compose hangt
   (mounts, volumes `/data` en `/config`, poorten, env), en hoe je lokaal test met
   `tls internal` en met LE-staging (`acme_ca https://acme-staging-v02.api.letsencrypt.org/directory`).
2. **`NewCaddy`** tegen de admin-API (`cfg.AdminURL`): dynamische routes herkenbaar maken
   (bv. `@id` = `panel-dyn-<host>`), vaste routes nooit aanraken. `SetRoute`, `RemoveRoute`,
   `Sync` (exacte set: toevoegen, bijwerken, weghalen), `Status`, en `Healthy`
   (`GET /config/` of `/reverse_proxy/upstreams`). Redirects (`RedirectTo`) als 308 met
   behoud van pad. Hostnamen lowercase. Veilig voor gelijktijdig gebruik.
   Netwerk-koppeling (`Upstream.Network`): Caddy-container (`cfg.CaddyContainer`) koppelen
   aan het netwerk als er een route naar wijst en loskoppelen na de laatste — alleen
   netwerken met `panel.managed=true` en `panel.instance=cfg.Instance`. Mag in fase 1 al,
   moet uiterlijk in fase 2.
3. **SSL-status** zo goed als in fase 1 kan: `active` als Caddy een geldig certificaat voor de
   host serveert (bv. TLS-dial naar Caddy met SNI en de keten controleren), anders
   `pending`/`issuing`; `dns_wrong`/`failed` uit Caddy-logs of -events mag in fase 3.

**Tests**: echte Caddy in Docker (`caddy:2`, label `panel.test=true` + eigen instance-label,
eigen vrije admin- en HTTP(S)-poorten) met `tls internal` voor `*.test`: route zetten, verkeer
naar een echo-container, redirect, Sync verwijdert wat weg moet, vaste routes blijven, Caddy
herstarten → `Healthy` faalt en daarna Sync herstelt. Unit-tests met een `httptest`-admin-API.

**Klaar als**: `make check` groen, de echte-Caddy-tests groen, en de basisconfig + README
staan zo dat templates-ops hem zonder vragen in compose kan zetten. "Site bereikbaar op
testdomein met geldig certificaat" wordt in fase 1 bewezen voor het panel- en daemon-domein.

## Fase 2
Statische nginx-template (`templates/web/static.yaml`, niet-root, `http_port`), eigen netwerk
per site in de koppeling volledig afronden.

## Fase 3
nginx + PHP-FPM 8.2/8.3/8.4- en Node.js-templates, redirects www ↔ kaal, wildcard via
DNS-challenge (`caddy-dns/cloudflare`, `DNSChallenge` in de Route), SSL-status volledig
(`dns_wrong`, `failed` met reden) naar de daemon.

## Fase 4
Backup van sites inclusief database controleren, foutmeldingen in het domeinscherm afronden
(met panel-ui/panel-api via de orchestrator).
