#!/bin/sh
# Entrypoint of panel-rspamd. Rspamd's own resolver needs an IP address: look up the Unbound container
# (MAIL_DNS_HOST, default unbound) and pass it as RSPAMD_DNS_SERVER (used in local.d/options.inc).
set -eu
host="${MAIL_DNS_HOST:-unbound}"
ip=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  ip="$(getent ahostsv4 "$host" 2>/dev/null | awk 'NR==1 {print $1}')"
  [ -n "$ip" ] && break
  sleep 1
done
if [ -z "$ip" ]; then
  ip=127.0.0.11 host=docker
  echo "rspamd: $host not found; falling back to the Docker resolver (blacklist lookups may fail)" >&2
fi
export RSPAMD_DNS_SERVER="$ip"
echo "rspamd: DNS resolver $host ($ip)" >&2
# Created here as well, for a mail-dkim volume that already existed before the image had the file.
[ -e /var/lib/rspamd/dkim/selectors.map ] || : > /var/lib/rspamd/dkim/selectors.map
exec "$@"
