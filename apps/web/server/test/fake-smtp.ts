/** Kleine nep-SMTP-server (node:net) voor tests: ontvangt mails, ondersteunt AUTH PLAIN/LOGIN, kan fouten geven. */
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

export interface ReceivedMail {
  from: string;
  to: string[];
  data: string;
  auth: { user: string; pass: string } | null;
  /** Ruwe headers + body, gedecodeerd waar nodig door de test. */
  subject: string;
}

export class FakeSmtp {
  readonly mails: ReceivedMail[] = [];
  /** Volgende DATA (of RCPT) beantwoorden met deze fout, bv. "451 try later" of "550 no such user". */
  failData: string | null = null;
  failRcpt: string | null = null;
  /** Vereist dit wachtwoord bij AUTH (anders 535). */
  password: string | null = null;
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  port = 0;

  async start(): Promise<number> {
    this.server = createServer((s) => this.session(s));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server.address() as AddressInfo).port;
    return this.port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private session(s: Socket) {
    this.sockets.add(s);
    s.on("close", () => this.sockets.delete(s));
    s.on("error", () => {});
    let buf = "";
    let mode: "cmd" | "data" | "authUser" | "authPass" = "cmd";
    let cur: ReceivedMail = { from: "", to: [], data: "", auth: null, subject: "" };
    let user = "";
    const w = (l: string) => s.write(`${l}\r\n`);
    w("220 fake-smtp ready");
    s.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (mode === "data") {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          cur.data = buf.slice(0, end).replace(/\r\n\.\./g, "\r\n.");
          buf = buf.slice(end + 5);
          mode = "cmd";
          if (this.failData) {
            const f = this.failData;
            this.failData = null;
            w(f);
          } else {
            const m = /^Subject: (.*)$/im.exec(cur.data);
            cur.subject = m?.[1]?.trim() ?? "";
            this.mails.push(cur);
            w("250 OK queued");
          }
          cur = { from: "", to: [], data: "", auth: cur.auth, subject: "" };
          continue;
        }
        const i = buf.indexOf("\r\n");
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (mode === "authUser") {
          user = Buffer.from(line, "base64").toString();
          mode = "authPass";
          w("334 UGFzc3dvcmQ6");
          continue;
        }
        if (mode === "authPass") {
          mode = "cmd";
          this.auth(user, Buffer.from(line, "base64").toString(), cur, w);
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO") w("250-fake-smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME");
        else if (cmd === "HELO") w("250 fake-smtp");
        else if (cmd === "AUTH") {
          const [, kind, arg] = line.split(" ");
          if (kind?.toUpperCase() === "PLAIN") {
            const [, u, p] = Buffer.from(arg ?? "", "base64").toString().split("\0");
            this.auth(u ?? "", p ?? "", cur, w);
          } else {
            mode = "authUser";
            w("334 VXNlcm5hbWU6");
          }
        } else if (cmd === "MAIL") (cur.from = /<([^>]*)>/.exec(line)?.[1] ?? ""), w("250 OK");
        else if (cmd === "RCPT") {
          if (this.failRcpt) {
            const f = this.failRcpt;
            this.failRcpt = null;
            w(f);
          } else (cur.to.push(/<([^>]*)>/.exec(line)?.[1] ?? ""), w("250 OK"));
        } else if (cmd === "DATA") (mode = "data"), w("354 go ahead");
        else if (cmd === "RSET") (cur = { from: "", to: [], data: "", auth: cur.auth, subject: "" }), w("250 OK");
        else if (cmd === "NOOP") w("250 OK");
        else if (cmd === "QUIT") (w("221 bye"), s.end());
        else w("502 not implemented");
      }
    });
  }

  private auth(user: string, pass: string, cur: ReceivedMail, w: (l: string) => void) {
    if (this.password !== null && pass !== this.password) return w("535 authentication failed");
    cur.auth = { user, pass };
    w("235 OK");
  }

  /** Body van een mail zonder transfer-encoding (quoted-printable) voor eenvoudige controles. */
  static decoded(m: ReceivedMail): string {
    return m.data.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  }
}
