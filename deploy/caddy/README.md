# Caddy base config

Owner: web-hosting. Caddy is the only entry point for HTTP(S) on the node.

| File | What |
|---|---|
| `Caddyfile` | Base config: `$PANEL_DOMAIN` → `panel:3000`, `$NODE_DOMAIN` → daemon socket, HTTP → HTTPS. Do not modify per installation. |
| `global.d/` | Extra global options (`*.caddy`). **Empty** in production. Not committed. |
| `examples/local-certs.caddy` | `tls internal` for everything (local testing, no internet). |
| `examples/le-staging.caddy` | Let's Encrypt **staging** (real ACME flow, untrusted certificate). |

## How the routes work

- **Static** (in the `Caddyfile`): panel and daemon. They keep working when the daemon is down.
- **Dynamic** (customer domains): the daemon adds them via the admin API (`proxy.NewCaddy`) to the
  HTTPS server named `panel` (`servers :443 { name panel }`), as routes with
  `"@id": "panel-dyn-<host>"` after the static routes. Routes without that prefix are never
  touched by the daemon. They are gone after a Caddy restart; the daemon notices through the health check and
  re-adds them (`Sync`). Therefore **do not use `--resume`**: at startup the `Caddyfile` is
  always the source of truth.
- HTTP → HTTPS (308) and certificates are handled by Caddy itself (automatic HTTPS), also for the
  dynamic hosts.

## In docker-compose (for templates-ops)

```yaml
services:
  caddy:
    build: ./caddy                      # deploy/caddy/Dockerfile: caddy + caddy-dns/cloudflare
    image: panel-caddy:local
    container_name: panel-caddy         # = CADDY_CONTAINER in panel.env
    restart: unless-stopped
    env_file: /etc/panel/panel.env      # uses PANEL_DOMAIN, NODE_DOMAIN, ACME_EMAIL
    # no command: the default command (caddy run --config /etc/caddy/Caddyfile
    # --adapter caddyfile) is fine; do not add --resume.
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"                   # HTTP/3, optional
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy/global.d:/etc/caddy/global.d:ro
      - /run/panel:/run/panel           # the directory, not the socket itself (it gets recreated)
      - caddy_data:/data                # certificates + ACME account: must persist
      - caddy_config:/config
    networks: [default]                 # same network as the `panel` service
    labels:
      panel.managed: "true"
      panel.instance: main

volumes:
  caddy_data:
    labels: { panel.managed: "true", panel.instance: main }
  caddy_config:
    labels: { panel.managed: "true", panel.instance: main }
```

Points that matter:

- **The `panel` service** must be on the same network and listen on port 3000
  (`reverse_proxy panel:3000`).
- **Mount `/run/panel`** as a directory. The daemon (systemd, `RuntimeDirectory=panel`) creates
  `daemon.sock` there. Also set **`RuntimeDirectoryPreserve=yes`** in the unit: otherwise systemd removes
  the directory when the daemon restarts and the Caddy container no longer sees the new directory (and socket)
  until Caddy itself restarts.
- **Socket permissions**: Caddy runs as root in the container, so `0660 root:root` is enough.
- **The admin API** only listens on the unix socket `/run/panel/caddy-admin.sock` (in the shared
  directory), **not on TCP and never published**: Caddy is attached to site networks and sites must not
  reach it. The daemon uses `CADDY_ADMIN_URL=unix:///run/panel/caddy-admin.sock` (on the socket
  Caddy does no Host check). The SSL check connects to `CADDY_TLS_ADDR` (default
  `127.0.0.1:443`).
- **Site networks**: the daemon attaches `panel-caddy` to site networks with
  `panel.managed=true` + `panel.instance=$PANEL_INSTANCE` + `panel.role=site` and detaches it
  after the last route. It never touches other networks (such as the compose network with `panel.role=infra`).
- **Panel → daemon**: the panel reaches `https://$NODE_DOMAIN` via Caddy; give the panel container
  `extra_hosts: ["${NODE_DOMAIN}:host-gateway"]` so that this works without external DNS (hairpin) too.
- Do not throw away `/data`: it holds the certificates. Without a volume Caddy requests new ones on every
  restart and you run into the Let's Encrypt rate limits.

## Wildcards and the DNS challenge

The image is built from `Dockerfile` (xcaddy, with Caddy and `caddy-dns/cloudflare` pinned).
A route with `DNSChallenge{Provider: "cloudflare", APIToken}` gets a TLS policy
`panel-tls-<host>` in `apps/tls/automation/policies` with subjects `*.domain` and `domain`,
the ACME issuers (email, CA) of the base config and `challenges.dns.provider`. The router
places that policy before the one from the base config and removes it on `RemoveRoute`/`Sync`.
The token only lives in the Caddy config (not in the route, not in error messages).
Test with your own build:

```sh
docker build -t panel-caddy-test:web-hosting deploy/caddy
cd daemon && PANEL_CADDY_IMAGE=panel-caddy-test:web-hosting go test ./proxy -run TestDockerCaddyDNSChallenge -v
```

## SSL status

`Status` returns `active` when Caddy serves a valid certificate. Otherwise the router looks
in Caddy's log (Docker logs of `CADDY_CONTAINER`, last 6 hours): a failed attempt with
a DNS or reachability error from the CA → `dns_wrong`, any other error → `failed` (reason
in `Error`). If still inconclusive it compares the A/AAAA records of the host with the IPs
of this node (`NODE_DOMAIN` + own interfaces): no record or no overlap → `dns_wrong`.
Note: a host behind the Cloudflare proxy gives `dns_wrong` until a certificate exists.

## Behind Nginx Proxy Manager (`HTTP_MODE=npm`)

`Caddyfile.npm` (remote node, compose profile `caddy-npm`) and `Caddyfile.npm-panel` (panel machine, via
`docker-compose.npm.yml`) run Caddy without TLS: `auto_https off`, the server `panel` on `:80` (the daemon puts the dynamic
routes there as usual) and `trusted_proxies static private_ranges` so the `X-Forwarded-*` headers of NPM reach the sites.
Compose publishes `:80` only on `NPM_CADDY_ADDR` (default `172.17.0.1:8081`). Nginx Proxy Manager terminates TLS; the daemon
(`daemon/proxy/npm.go`) creates a proxy host per domain there that forwards to that address, and the SSL status comes from NPM.
Test: `go test ./proxy -run TestRealNPM` (real `jc21/nginx-proxy-manager` + Caddy with `Caddyfile.npm`).

## Local testing with `tls internal`

On your own free ports, not 80/443/2019 (other things may run on this machine); the admin API
is on the socket in `$work/run`:

```sh
work=$(mktemp -d); mkdir -p "$work/global.d" "$work/run"
cp deploy/caddy/examples/local-certs.caddy "$work/global.d/"
docker run -d --name caddy-test-$$ \
  --label panel.test=true --label panel.instance=caddy-test-$$ \
  -p 127.0.0.1:10080:80 -p 127.0.0.1:10443:443 \
  -e PANEL_DOMAIN=panel.test -e NODE_DOMAIN=node1.test -e ACME_EMAIL=admin@panel.test \
  -v "$PWD/deploy/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$work/global.d:/etc/caddy/global.d:ro" -v "$work/run:/run/panel" caddy:2

# fetch the root of Caddy's internal CA and check the certificate
curl -s --unix-socket "$work/run/caddy-admin.sock" http://caddy/pki/ca/local | python3 -c 'import json,sys;print(json.load(sys.stdin)["root_certificate"])' > "$work/root.pem"
curl -v --cacert "$work/root.pem" --resolve panel.test:10443:127.0.0.1 https://panel.test:10443/
curl -I --resolve panel.test:10080:127.0.0.1 http://panel.test:10080/   # 308 to https

docker rm -f caddy-test-$$
```

(Without a container with network alias `panel` the panel domain returns 502; the certificate is
valid though.) The Go tests in `daemon/proxy/caddy_docker_test.go` do exactly this, with an
echo container as panel, a fake daemon on the socket (incl. websocket) and a site network:

```sh
cd daemon && go test -run TestDockerCaddy -v ./proxy/
```

## Testing with Let's Encrypt staging

Copy `examples/le-staging.caddy` to `global.d/` (or mount it as
`/etc/caddy/global.d/le-staging.caddy`). For this the domains must really point at the machine
and ports 80/443 must be publicly reachable. The staging certificate is not trusted (`curl -k` or the staging root); the SSL status in the
panel therefore stays `issuing`. Remove the file again for production and delete the
staging certificates from `/data` (`caddy_data` volume) when you switch.

## Validating

```sh
docker run --rm -e PANEL_DOMAIN=panel.test -e NODE_DOMAIN=node1.test -e ACME_EMAIL=a@panel.test \
  -v "$PWD/deploy/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2 \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```
