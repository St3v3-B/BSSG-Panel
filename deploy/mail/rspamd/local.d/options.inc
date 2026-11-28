# Own recursive resolver (container unbound): DNS blacklists (Spamhaus etc.) refuse public resolvers.
# RSPAMD_DNS_SERVER is set by the entrypoint (IP of the unbound container).
dns {
  nameserver = ["{= env.DNS_SERVER|default('127.0.0.11') =}:53"];
  timeout = 2s;
  retransmits = 2;
}
