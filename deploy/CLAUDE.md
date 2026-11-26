# templates-ops — game-templates en deploy

Eigen mappen: `templates/game/` en `deploy/` (behalve `deploy/caddy/`, van web-hosting, en de
namen van variabelen in `deploy/panel.env.example`: nieuwe variabele nodig → contractvraag).
Lees de root-`CLAUDE.md` en `templates/SCHEMA.md`.

## Fase 1 — taak

1. **`templates/game/paper.yaml`** volgens `templates/SCHEMA.md`: Paper via de PaperMC-API
   (versie-variabele `MINECRAFT_VERSION`, standaard `latest`, en eventueel `BUILD`), EULA
   accepteren, `server.properties` met `server-port={{SERVER_PORT}}` en `server-ip` via
   `config_files`, Java-image dat als uid 1000 draait met read-only rootfs + tmpfs `/tmp`
   (Aikar-flags mogen), stop = `stop`, `ready_pattern` dat `Done (` matcht.
   De test in `packages/api/contract.test.ts` valideert het bestand.
2. **`deploy/docker-compose.yml`**: `panel` (image uit `deploy/panel.Dockerfile`: monorepo
   bouwen, Next standalone, `templates/` naar `/app/templates`, draait niet als root),
   `postgres:16`, `redis:7`, `caddy` (basisconfig uit `deploy/caddy/`, zie de README daar).
   `env_file: /etc/panel/panel.env`. Alle containers/netwerken/volumes labels
   `panel.managed=true` en `panel.instance=main`. Panel publiceert alleen `127.0.0.1:3000`;
   Caddy `80`, `443` en `127.0.0.1:2019`; `/run/panel` gemount in Caddy. Zorg dat het panel
   `DAEMON_URL` (standaard `https://$NODE_DOMAIN`) kan bereiken, bv. via
   `extra_hosts: "${NODE_DOMAIN}:host-gateway"`. Postgres/Redis niet publiceren.
3. **`deploy/systemd/panel-daemon.service`**: `EnvironmentFile=/etc/panel/panel.env`,
   `RuntimeDirectory=panel` (→ `/run/panel`), `Restart=always`, en zo dat een herstart van de
   unit de containers laat draaien.
4. **`deploy/install.sh`** (eerste versie, vanuit een checkout van deze repo): vereisten
   controleren (Docker, compose, Go of een kant-en-klare binary), waarden vragen en
   `/etc/panel/panel.env` schrijven (sleutels en `NODE_TOKEN` genereren, chmod 600; bestaande
   waarden behouden), daemon bouwen en installeren, unit installeren en starten,
   `docker compose up -d --build`. Zo idempotent als het al gaat; een `--non-interactive`
   modus met env-variabelen. Ook een korte `deploy/README.md`.

**Tests** (`deploy/test.sh`, ook aan te roepen vanuit `make check` is niet nodig): shellcheck
(via `koalaman/shellcheck`-image), `docker compose config` met een test-env, `install.sh` in een
dry-run-modus die naar een tijdelijke map schrijft in plaats van `/etc`, en een Paper-rooktest:
install-script in een container (label `panel.test=true` + eigen instance-label) draaien, dan de
server starten met 1 GB tot het ready-patroon verschijnt, en opruimen. **Installeer niets echt
op deze machine** — dat doet de orchestrator bij de mijlpaaltest.

**Klaar als**: `make check` groen, `deploy/test.sh` groen, en de orchestrator kan met jouw
bestanden mijlpaal 1 op deze machine uitvoeren.

## Fase 2
Templates: Folia, Velocity, Fabric, generiek Java (met Java-versiekeuze), generiek Node.js.

## Fase 3
MariaDB 11 in de deploy (eigen netwerk, alleen 3306 intern), Adminer als site-template,
Caddy-build met `caddy-dns/cloudflare` (samen met web-hosting via de orchestrator).

## Fase 4
Installscript af: één commando, volledig idempotent; `deploy/uninstall.sh` haalt alles weg
(containers/netwerken/volumes met de panel-labels, `/var/lib/panel`, `/etc/panel`, de unit);
documentatie in `docs/`.
