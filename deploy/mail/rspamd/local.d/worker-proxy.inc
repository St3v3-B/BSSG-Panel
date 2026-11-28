# Milter for Postfix (inet:rspamd:11332), scanning in the same process (self_scan).
# Binds on all interfaces of the container (RSPAMD_LOCAL_ADDR=* in the image), i.e. only on the internal
# Docker network panel-mail; nothing is published.
milter = yes;
timeout = 120s;
upstream "local" {
  default = yes;
  self_scan = yes;
}
