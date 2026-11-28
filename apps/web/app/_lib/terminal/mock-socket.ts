/** Nep-terminal voor mock-modus (NEXT_PUBLIC_PANEL_MOCK=1): een kleine regel-editor met een paar commando's. */
import type { TerminalSocket } from "./session";

const enc = new TextEncoder();
const dec = new TextDecoder();

export class MockTerminalSocket implements TerminalSocket {
  readyState = 0;
  binaryType = "arraybuffer";
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private line = "";
  private authed = false;

  constructor(readonly url: string) {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 30);
  }

  private out(s: string) {
    const b = enc.encode(s);
    setTimeout(() => this.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }), 0);
  }
  private event(v: unknown) {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(v) }), 0);
  }
  private prompt() {
    this.out("\x1b[32mcontainer@mock\x1b[0m:\x1b[34m~\x1b[0m$ ");
  }

  send(data: string | ArrayBufferLike | Uint8Array): void {
    if (typeof data === "string") {
      const m = JSON.parse(data) as { event: string };
      if (m.event === "auth" && !this.authed) {
        this.authed = true;
        this.event({ event: "auth_success" });
        this.out("Mock terminal: tools container with /home/container.\r\nTry: ls, php -v, composer --version, exit\r\n");
        this.prompt();
      }
      return;
    }
    const text = dec.decode(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer));
    for (const ch of text) {
      if (ch === "\r") {
        this.out("\r\n");
        this.run(this.line.trim());
        this.line = "";
      } else if (ch === "\x7f") {
        if (this.line) {
          this.line = this.line.slice(0, -1);
          this.out("\b \b");
        }
      } else if (ch === "\x03") {
        this.out("^C\r\n");
        this.line = "";
        this.prompt();
      } else if (ch >= " ") {
        this.line += ch;
        this.out(ch);
      }
    }
  }

  private run(cmd: string) {
    if (cmd === "exit") {
      this.event({ event: "terminal_exit", code: 0 });
      setTimeout(() => this.close(1000, "shell exited"), 10);
      return;
    }
    const answers: Record<string, string> = {
      ls: "\x1b[34mpublic\x1b[0m  \x1b[34mnginx\x1b[0m  \x1b[34mphp\x1b[0m  composer.json",
      "php -v": "PHP 8.3.14 (cli) (built: Nov 21 2026)",
      "composer --version": "Composer version 2.8.3",
      pwd: "/home/container",
      whoami: "container",
    };
    if (cmd) this.out(`${answers[cmd] ?? `sh: ${cmd.split(" ")[0]}: not found (mock)`}\r\n`);
    this.prompt();
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.onclose?.({ code, reason }), 0);
  }
}
