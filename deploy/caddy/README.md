# Caddy-basisconfig

Eigenaar: web-hosting. Caddy is de enige ingang voor HTTP(S) op de node.

| Bestand | Wat |
|---|---|
| `Caddyfile` | Basisconfig: `$PANEL_DOMAIN` → `panel:3000`, `$NODE_DOMAIN` → daemon-socket, HTTP → HTTPS. Niet per installatie aanpassen. |
| `global.d/` | Extra globale opties (`*.caddy`). In productie **leeg**. Wordt niet gecommit. |
| `examples/local-certs.caddy` | `tls internal` voor alles (lokaal testen, geen internet). |
| `examples/le-staging.caddy` | Let's Encrypt **staging** (echte ACME-flow, onvertrouwd certificaat). |

## Hoe de routes werken

- **Vast** (in de `Caddyfile`): panel en daemon. Blijven werken als de daemon plat ligt.
- **Dynamisch** (klantdomeinen): de daemon zet ze via de admin-API (`proxy.NewCaddy`) in de
  HTTPS-server met de naam `panel` (`servers :443 { name panel }`), als routes met
  `"@id": "panel-dyn-<host>"` achter de vaste routes. Routes zonder dat prefix raakt de daemon
  nooit aan. Bij een herstart van Caddy zijn ze weg; de daemon merkt dat via de health-check en
  zet ze opnieuw (`Sync`). Daarom **geen `--resume`** gebruiken: de `Caddyfile` is bij de start
  altijd de bron.
- HTTP → HTTPS (308) en certificaten regelt Caddy zelf (automatic HTTPS), ook voor de
  dynamische hosts.

## In docker-compose (voor templates-ops)

```yaml
services:
  caddy:
    image: caddy:2                      # fase 3: eigen build met caddy-dns/cloudflare
    container_name: panel-caddy         # = CADDY_CONTAINER in panel.env
    restart: unless-stopped
    env_file: /etc/panel/panel.env      # gebruikt PANEL_DOMAIN, NODE_DOMAIN, ACME_EMAIL
    # geen command: het standaardcommando (caddy run --config /etc/caddy/Caddyfile
    # --adapter caddyfile) is goed; niet --resume toevoegen.
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"                   # HTTP/3, optioneel
      - "127.0.0.1:2019:2019"           # admin-API, alleen localhost (CADDY_ADMIN_URL)
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy/global.d:/etc/caddy/global.d:ro
      - /run/panel:/run/panel           # map, niet de socket zelf (die wordt opnieuw gemaakt)
      - caddy_data:/data                # certificaten + ACME-account: moet blijven bestaan
      - caddy_config:/config
    networks: [default]                 # zelfde netwerk als de service `panel`
    labels:
      panel.managed: "true"
      panel.instance: main

volumes:
  caddy_data:
    labels: { panel.managed: "true", panel.instance: main }
  caddy_config:
    labels: { panel.managed: "true", panel.instance: main }
```

Punten die ertoe doen:

- **Service `panel`** moet op hetzelfde netwerk zitten en op poort 3000 luisteren
  (`reverse_proxy panel:3000`).
- **`/run/panel`** als map mounten. De daemon (systemd, `RuntimeDirectory=panel`) maakt daar
  `daemon.sock`. Zet in de unit ook **`RuntimeDirectoryPreserve=yes`**: anders verwijdert systemd
  de map bij een herstart van de daemon en ziet de Caddy-container de nieuwe map (en socket) niet
  meer tot Caddy zelf herstart.
- **Socket-rechten**: Caddy draait in de container als root, dus `0660 root:root` is genoeg.
- **Admin-API** staat binnen de container op `0.0.0.0:2019`; publiceer hem alleen op
  `127.0.0.1`. De daemon gebruikt `CADDY_ADMIN_URL=http://127.0.0.1:2019`.
- **Netwerken van sites**: de daemon koppelt `panel-caddy` aan site-netwerken met
  `panel.managed=true` + `panel.instance=$PANEL_INSTANCE` en koppelt hem los na de laatste route.
  Netwerken die docker-compose maakt (label `com.docker.compose.project`) worden nooit
  losgekoppeld, dus het compose-netwerk naar het panel blijft altijd staan.
- **Panel → daemon**: het panel bereikt `https://$NODE_DOMAIN` via Caddy; geef de panel-container
  `extra_hosts: ["${NODE_DOMAIN}:host-gateway"]` zodat dat ook zonder externe DNS (hairpin) werkt.
- `/data` niet weggooien: daar staan de certificaten. Zonder volume vraagt Caddy bij elke
  herstart nieuwe aan en loop je tegen de rate limits van Let's Encrypt aan.

## Lokaal testen met `tls internal`

Op eigen vrije poorten, niet 80/443/2019 (op deze machine draait ander spul):

```sh
work=$(mktemp -d); mkdir -p "$work/global.d" "$work/run"
cp deploy/caddy/examples/local-certs.caddy "$work/global.d/"
docker run -d --name caddy-test-$$ \
  --label panel.test=true --label panel.instance=caddy-test-$$ \
  -p 127.0.0.1:12019:2019 -p 127.0.0.1:10080:80 -p 127.0.0.1:10443:443 \
  -e PANEL_DOMAIN=panel.test -e NODE_DOMAIN=node1.test -e ACME_EMAIL=admin@panel.test \
  -v "$PWD/deploy/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$work/global.d:/etc/caddy/global.d:ro" -v "$work/run:/run/panel" caddy:2

# root van Caddy's interne CA ophalen en het certificaat controleren
curl -s http://127.0.0.1:12019/pki/ca/local | python3 -c 'import json,sys;print(json.load(sys.stdin)["root_certificate"])' > "$work/root.pem"
curl -v --cacert "$work/root.pem" --resolve panel.test:10443:127.0.0.1 https://panel.test:10443/
curl -I --resolve panel.test:10080:127.0.0.1 http://panel.test:10080/   # 308 naar https

docker rm -f caddy-test-$$
```

(Zonder container met netwerk-alias `panel` geeft het panel-domein 502; het certificaat is wel
geldig.) De Go-tests in `daemon/proxy/caddy_docker_test.go` doen precies dit, met een
echo-container als panel, een nep-daemon op de socket (incl. websocket) en een site-netwerk:

```sh
cd daemon && go test -run TestDockerCaddy -v ./proxy/
```

## Testen met Let's Encrypt staging

Kopieer `examples/le-staging.caddy` naar `global.d/` (of mount hem als
`/etc/caddy/global.d/le-staging.caddy`). Daarvoor moeten de domeinen echt naar de machine wijzen
en moeten poort 80/443 publiek bereikbaar zijn — op deze machine doet alleen de orchestrator dat.
Het staging-certificaat is niet vertrouwd (`curl -k` of de staging-root); de SSL-status in het
panel blijft daardoor `issuing`. Haal het bestand weer weg voor productie en verwijder de
staging-certificaten uit `/data` (`caddy_data`-volume) als je wisselt.

## Controleren

```sh
docker run --rm -e PANEL_DOMAIN=panel.test -e NODE_DOMAIN=node1.test -e ACME_EMAIL=a@panel.test \
  -v "$PWD/deploy/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2 \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```
