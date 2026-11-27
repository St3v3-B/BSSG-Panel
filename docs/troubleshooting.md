# Troubleshooting

## Logs

```bash
journalctl -u panel-daemon -f                 # daemon
docker logs -f panel-web                      # panel
docker logs -f panel-caddy                    # Caddy and certificates
docker compose --env-file /etc/panel/panel.env -f deploy/docker-compose.yml ps
```

## Common problems

| Symptom | Likely cause and fix |
|---|---|
| Certificate stays `issuing` or shows `dns_wrong` | The A record does not point at the node, or the Cloudflare proxy (orange cloud) is on. Set it to DNS only. |
| Discord says "invalid redirect" | The redirect URI in the Discord portal must be exactly `https://<PANEL_DOMAIN>/api/auth/discord/callback`. |
| `/admin` redirects to Account | Admins must enable 2FA and verify it in the current session. |
| Login says you are blocked or pending | An admin has to approve or unblock your account. |
| Website shows "this website is being set up" | The install is still running. PHP templates compile extensions on first install (one to two minutes). |
| Upload refused, disk full | The server hit its disk limit. Delete files or ask an admin to raise it. The warning appears at 90%. |
| Console does not connect | Check that `NODE_DOMAIN` resolves to the node and that `systemctl status panel-daemon` is running. |
| Minecraft server killed right after start | Memory limit too low for the heap. Give it more RAM. |
| Server status `unknown` | The panel cannot reach the node. Check the daemon, Caddy and the node's token. |
| Port 80, 443 or 2022 already in use | Stop the other service. The installer needs them. |
| Bedrock players cannot join | Open the UDP port in your firewall and check the Bedrock tab. |
| Sleeping server does not wake up | It was stopped by hand (that means off), or the template does not support sleep mode. |

## Things worth knowing

- There is no IPv6. Remove AAAA records for your domains.
- Restarting `panel-daemon` does not stop game servers. Containers belong to Docker.
- The panel only touches Docker objects with its own labels, so other containers on the machine stay untouched.

## Still stuck?

Open an issue with the output of `docker compose ... ps`, the relevant log lines and the panel version (git commit). Remove domains, tokens and secrets first.
Security problems go through [SECURITY.md](../SECURITY.md).
