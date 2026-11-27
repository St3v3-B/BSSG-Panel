#!/usr/bin/env bash
# Ruimt lege Docker-netwerken op die tests lieten staan (label panel.test=true), maar alleen als
# het proces uit het instance-label niet meer draait. Raakt nooit panel.instance=main of netwerken
# met containers. Aangeroepen vóór de Go-tests in `make check`: afgebroken runs (timeouts) lieten
# netwerken achter tot Docker "all predefined address pools have been fully subnetted" gaf.
set -uo pipefail
command -v docker >/dev/null || exit 0
# Eerst containers van afgebroken runs (proces uit het instance-label draait niet meer).
for inst in $(docker ps -a --filter label=panel.test=true --format '{{.Label "panel.instance"}}' 2>/dev/null | sort -u); do
  [ "$inst" = main ] && continue
  pid=$(echo "$inst" | grep -oE '[0-9]{3,}' | head -1)
  [ -z "$pid" ] && continue
  kill -0 "$pid" 2>/dev/null && continue
  ids=$(docker ps -aq --filter label=panel.test=true --filter "label=panel.instance=$inst")
  [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1 && echo "cleanup-test-networks: containers van $inst verwijderd"
done
n=0
for id in $(docker network ls -q --filter label=panel.test=true 2>/dev/null); do
  inst=$(docker network inspect -f '{{index .Labels "panel.instance"}}' "$id" 2>/dev/null) || continue
  [ "$inst" = main ] && continue
  [ "$(docker network inspect -f '{{len .Containers}}' "$id" 2>/dev/null)" = 0 ] || continue
  pid=$(echo "$inst" | grep -oE '[0-9]{3,}' | head -1)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then continue; fi
  docker network rm "$id" >/dev/null 2>&1 && n=$((n+1))
done
[ "$n" -gt 0 ] && echo "cleanup-test-networks: $n achtergebleven testnetwerken verwijderd"
exit 0
