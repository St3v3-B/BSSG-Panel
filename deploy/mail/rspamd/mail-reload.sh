#!/bin/sh
# `docker exec panel-rspamd mail-reload`: reload the configuration and DKIM keys (SIGHUP to the main
# process, PID 1). Called by the daemon after writing a DKIM key and by POST /api/mail/reload.
set -eu
kill -HUP 1
