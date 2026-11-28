/**
 * Neppen voor de feature-specs: een minimale SMTP-server (vangt mails op) en phpMyAdmin achter een
 * kleine reverse proxy op dezelfde origin als het panel (zoals Caddy in productie).
 * Docker-objecten krijgen panel.test=true + het instance-label van deze run (run.sh ruimt ze op).
 */
import { execFileSync } from "node:child_process";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import { connect, createServer, type Socket } from "node:net";
import { env } from "../integration/helpers";

export interface Mail {
  from: string;
  to: string[];
  data: string;
}

/** SMTP zonder TLS/auth op 127.0.0.1 (geen STARTTLS aangeboden). */
export async function startFakeSmtp(): Promise<{ port: number; mails: Mail[]; close: () => Promise<void> }> {
  const mails: Mail[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.setEncoding("utf8");
    let buf = "";
    let inData = false;
    let cur: Mail = { from: "", to: [], data: "" };
    const reply = (s: string) => sock.write(`${s}\r\n`);
    reply("220 fake.test ESMTP");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          cur.data = buf.slice(0, end).replace(/^\.\./gm, ".");
          buf = buf.slice(end + 5);
          inData = false;
          mails.push(cur);
          cur = { from: "", to: [], data: "" };
          reply("250 OK queued");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO") reply("250-fake.test\r\n250 8BITMIME");
        else if (cmd === "HELO") reply("250 fake.test");
        else if (cmd === "MAIL") (cur.from = line.replace(/^MAIL FROM:\s*/i, "")), reply("250 OK");
        else if (cmd === "RCPT") cur.to.push(line.replace(/^RCPT TO:\s*/i, "")), reply("250 OK");
        else if (cmd === "DATA") (inData = true), reply("354 go ahead");
        else if (cmd === "QUIT") reply("221 bye"), sock.end();
        else reply("250 OK");
      }
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    mails,
    close: () => new Promise<void>((r) => (sockets.forEach((s) => s.destroy()), server.close(() => r()))),
  };
}

function docker(...args: string[]) {
  return execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

/**
 * phpMyAdmin uit deploy/phpmyadmin (image $IT_PMA_IMAGE, gebouwd door run.sh) op een eigen testnetwerk
 * met de test-MariaDB, plus een proxy die /phpmyadmin/* naar de container en de rest naar het panel stuurt.
 * Geeft de origin van de proxy (http://localhost:<poort>); de sessiecookie van localhost geldt daar ook.
 */
export async function startPhpMyAdmin(): Promise<{ origin: string; container: string; stop: () => Promise<void> }> {
  const instance = env("PANEL_INSTANCE");
  const tag = `${process.pid}-${Date.now() % 100000}`;
  const net = `qa-pma-net-${tag}`;
  const container = `qa-pma-${tag}`;
  const labels = ["--label", "panel.test=true", "--label", `panel.instance=${instance}`];
  const panel = new URL(env("IT_PANEL_URL"));
  // De proxy eerst: phpMyAdmin moet zijn eigen absolute URL kennen.
  let pmaPort = 0;
  const server: Server = createHttpServer((req, res) => {
    const toPma = req.url?.startsWith("/phpmyadmin/") || req.url === "/phpmyadmin";
    const target = toPma ? { host: "127.0.0.1", port: pmaPort, path: req.url!.replace(/^\/phpmyadmin/, "") || "/" } : { host: "127.0.0.1", port: Number(panel.port), path: req.url! };
    const up = httpRequest({ ...target, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => (res.headersSent ? res.destroy() : (res.writeHead(502), res.end("bad gateway"))));
    req.pipe(up);
  });
  // HMR-websocket van next dev door laten (anders alleen ruis in de console).
  server.on("upgrade", (req, sock, head) => {
    const up = connect(Number(panel.port), "127.0.0.1", () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      up.write(head);
      up.pipe(sock).pipe(up);
    });
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://localhost:${(server.address() as { port: number }).port}`;

  docker("network", "create", ...labels, net);
  docker("network", "connect", net, env("MARIADB_CONTAINER"));
  docker(
    "run", "-d", "--name", container, ...labels, "--network", net, "-p", "127.0.0.1::80",
    "--add-host", "host.docker.internal:host-gateway",
    "-e", `PMA_ABSOLUTE_URI=${origin}/phpmyadmin/`,
    "-e", `PMA_DB_HOST=${env("MARIADB_CONTAINER")}`,
    "-e", `PMA_PANEL_URL=http://host.docker.internal:${panel.port}`,
    "-e", `PMA_SHARED_SECRET=${env("PMA_SHARED_SECRET")}`,
    "-e", `PMA_BLOWFISH_SECRET=${env("PMA_BLOWFISH_SECRET")}`,
    "-e", "TZ=Europe/Amsterdam",
    env("IT_PMA_IMAGE"),
  );
  pmaPort = Number(docker("port", container, "80/tcp").split("\n")[0]!.split(":").pop());
  const end = Date.now() + 60_000;
  for (;;) {
    const ok = await fetch(`http://127.0.0.1:${pmaPort}/panel-return.html`).then((r) => r.ok, () => false);
    if (ok) break;
    if (Date.now() > end) throw new Error(`phpMyAdmin start niet: ${docker("logs", "--tail", "30", container)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    origin,
    container,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      try {
        docker("rm", "-f", container);
        docker("network", "disconnect", "-f", net, env("MARIADB_CONTAINER"));
        docker("network", "rm", net);
      } catch {}
    },
  };
}

/** TCP-proxy die het verkeer van client naar server afknijpt (bytes per seconde): maakt een backup traag. */
export async function startThrottle(targetPort: number, bytesPerSec: number): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const up = connect(targetPort, "127.0.0.1");
    sockets.add(client).add(up);
    client.on("close", () => (sockets.delete(client), up.destroy()));
    up.on("close", () => (sockets.delete(up), client.destroy()));
    client.on("error", () => up.destroy());
    up.on("error", () => client.destroy());
    client.on("data", (chunk: Buffer) => {
      up.write(chunk);
      client.pause();
      setTimeout(() => client.resume(), Math.ceil((chunk.length / bytesPerSec) * 1000));
    });
    up.pipe(client);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => (sockets.forEach((s) => s.destroy()), server.close(() => r()))),
  };
}

/** Decodeert quoted-printable (de mailbody van nodemailer) genoeg om links terug te vinden. */
export function decodeQp(s: string) {
  return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}
