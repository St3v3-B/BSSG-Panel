#!/usr/bin/env bash
# Faalt als er Go-bestanden zijn die niet gofmt'd zijn.
set -euo pipefail
unformatted=$(gofmt -l .)
if [ -n "$unformatted" ]; then
  echo "gofmt nodig voor:"
  echo "$unformatted"
  exit 1
fi
