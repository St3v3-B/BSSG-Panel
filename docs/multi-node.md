# Multi-node

One panel can drive several machines. Each machine runs the Go daemon, its own Caddy and its own MariaDB.
The panel talks to every daemon over HTTPS with a per-node token.

```text
                    +----------------+
 Browser  --------> |  Panel (main)  |
                    +--------+-------+
                             | HTTPS + node token
              +--------------+--------------+
        +-----v-----+                 +-----v-----+
        |  node1    |                 |  node2    |
        | daemon    |                 | daemon    |
        | Caddy     |                 | Caddy     |
        | MariaDB   |                 | MariaDB   |
        +-----------+                 +-----------+
```

## Adding a node

1. Create an A record for the new node, for example `node2.example.com`, pointing to the new machine.
2. In **Admin, Nodes** create a node with that FQDN. The panel shows a **one-time token** and a ready-made install command.
3. Run the command on the new machine as root (Docker and git required). It looks like this:

```bash
git clone --depth 1 https://github.com/St3v3-B/BSSG-Panel.git /opt/panel-node
PANEL_URL='https://panel.example.com' NODE_DOMAIN='node2.example.com' NODE_TOKEN='<token>' \
ACME_EMAIL='you@example.com' DAEMON_PORT='8080' SFTP_PORT='2022' \
  /opt/panel-node/deploy/install.sh --node-only --non-interactive
```

`--node-only` installs the daemon, its systemd unit, Caddy and its own MariaDB (`deploy/docker-compose.node.yml`). The node needs
`PANEL_URL`, `NODE_DOMAIN`, `NODE_TOKEN` and `ACME_EMAIL`.

4. Add allocations for the node under **Admin, Nodes**. Lost the token? Regenerate it from the same screen.

The panel monitors every node in the background and shows `unknown` for servers on a node it cannot reach. Admins can be notified when
a node goes offline or comes back.

## Transfers

Open a server in **Admin, Servers** and choose **Transfer** to move it to another node. The panel:

1. stops the server,
2. copies its data to the other node (including its databases),
3. starts it there again if it was running,
4. removes the source only after a successful copy.

Domains move along, but you must point their DNS records to the new node afterwards. If a Velocity proxy referenced the moved server, it
is updated automatically and needs a restart to use the new address.

## Domains per node

Each node has its own domain (`NODE_DOMAIN`) for the console websocket, file transfers and certificates. Websites and game-server
domains are served by the Caddy on the node where the server runs.
