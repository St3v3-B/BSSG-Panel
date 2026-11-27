import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffDelay, ConsoleConnection, MockSocket, type ConnState, type SocketLike, type WsServerMessage } from "@/app/_lib/console";
import { isMockTransport } from "@/app/_lib/console";

/** Nep-socket die vastlegt wat de client stuurt; de test speelt de daemon. */
class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  closedWith: number | null = null;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code = 1000) {
    this.closedWith = code;
    this.readyState = 3;
  }
  // daemon-kant
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(msg: WsServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0);

function setup(fetchToken?: () => Promise<{ token: string; socketUrl: string }>) {
  let n = 0;
  const fetch = vi.fn(fetchToken ?? (async () => ({ token: `jwt-${++n}`, socketUrl: "wss://node1.test/api/servers/abc/ws" })));
  const states: ConnState[] = [];
  const messages: Array<{ msg: WsServerMessage; fresh: boolean }> = [];
  const conn = new ConsoleConnection({
    fetchToken: fetch,
    createSocket: (url) => new FakeSocket(url),
    onState: (s) => states.push(s),
    onMessage: (msg, { fresh }) => messages.push({ msg, fresh }),
    onTokenError: (err) => (err as { data?: { code?: string } }).data?.code === "FORBIDDEN",
  });
  return { conn, fetch, states, messages, last: () => FakeSocket.all[FakeSocket.all.length - 1]! };
}

describe("ConsoleConnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
  });
  afterEach(() => vi.useRealTimers());

  it("stuurt auth als eerste bericht en wordt 'connected' na auth_success", async () => {
    const { conn, states, messages, last } = setup();
    conn.start();
    await flush();
    const ws = last();
    expect(ws.url).toBe("wss://node1.test/api/servers/abc/ws");
    ws.open();
    expect(ws.sent).toEqual([{ event: "auth", token: "jwt-1" }]);
    expect(conn.state).toBe("authenticating");
    ws.push({ event: "auth_success", permissions: ["console.read"] });
    expect(conn.state).toBe("connected");
    expect(messages[0]).toMatchObject({ msg: { event: "auth_success" }, fresh: true });
    expect(states).toEqual(["connecting", "authenticating", "connected"]);
  });

  it("socket open maar geen auth_success binnen 15 s: sluiten zodat hij opnieuw verbindt", async () => {
    const { conn, last } = setup();
    conn.start();
    await flush();
    const ws = last();
    ws.open();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(ws.closedWith).toBeNull();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(ws.closedWith).toBe(4000);
    conn.stop();
  });

  it("geen auth-timeout als auth_success op tijd komt", async () => {
    const { conn, last } = setup();
    conn.start();
    await flush();
    const ws = last();
    ws.open();
    ws.push({ event: "auth_success", permissions: ["console.read"] });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ws.closedWith).toBeNull();
    conn.stop();
  });

  it("token_expiring → nieuw token ophalen → opnieuw auth op dezelfde socket", async () => {
    const { conn, fetch, messages, last } = setup();
    conn.start();
    await flush();
    const ws = last();
    ws.open();
    ws.push({ event: "auth_success", permissions: [] });
    ws.push({ event: "token_expiring", expires_at: new Date(Date.now() + 60_000).toISOString() });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(FakeSocket.all).toHaveLength(1); // geen nieuwe verbinding
    expect(ws.sent).toEqual([
      { event: "auth", token: "jwt-1" },
      { event: "auth", token: "jwt-2" },
    ]);
    // de daemon bevestigt: geen nieuwe backlog-reset
    ws.push({ event: "auth_success", permissions: [] });
    expect(messages.filter((m) => m.msg.event === "auth_success").map((m) => m.fresh)).toEqual([true, false]);
    expect(conn.state).toBe("connected");
  });

  it("een tweede token_expiring tijdens een lopende refresh haalt geen extra token op", async () => {
    let resolve!: (v: { token: string; socketUrl: string }) => void;
    let first = true;
    const { conn, fetch, last } = setup(() => {
      if (first) {
        first = false;
        return Promise.resolve({ token: "jwt-1", socketUrl: "wss://node1.test/ws" });
      }
      return new Promise((r) => (resolve = r));
    });
    conn.start();
    await flush();
    last().open();
    last().push({ event: "auth_success" });
    last().push({ event: "token_expiring" });
    last().push({ event: "token_expiring" });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    resolve({ token: "jwt-2", socketUrl: "wss://node1.test/ws" });
    await flush();
    expect(last().sent.at(-1)).toEqual({ event: "auth", token: "jwt-2" });
  });

  it("token verlopen (4001) → opnieuw verbinden met een nieuw token", async () => {
    const { conn, fetch, states, last } = setup();
    conn.start();
    await flush();
    last().open();
    last().push({ event: "auth_success" });
    last().push({ event: "token_expired" });
    last().serverClose(4001);
    expect(conn.state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(FakeSocket.all).toHaveLength(2);
    last().open();
    expect(last().sent).toEqual([{ event: "auth", token: "jwt-2" }]);
    last().push({ event: "auth_success" });
    expect(states.at(-1)).toBe("connected");
  });

  it("reconnect met exponentiële backoff, en reset na een geslaagde auth", async () => {
    const { conn, last } = setup();
    conn.start();
    await flush();
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = FakeSocket.all.length;
      last().serverClose(1006);
      let waited = 0;
      while (FakeSocket.all.length === before) {
        await vi.advanceTimersByTimeAsync(500);
        waited += 500;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    last().open();
    last().push({ event: "auth_success" });
    last().serverClose(1006);
    const before = FakeSocket.all.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all.length).toBe(before + 1);
  });

  it("4003 (geen console.read) en 4004 → 'denied', geen nieuwe poging", async () => {
    for (const code of [4003, 4004]) {
      FakeSocket.all = [];
      const { conn, last } = setup();
      conn.start();
      await flush();
      last().open();
      last().serverClose(code);
      expect(conn.state).toBe("denied");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeSocket.all).toHaveLength(1);
    }
  });

  it("token ophalen faalt: FORBIDDEN → denied, andere fout → opnieuw proberen", async () => {
    const forbidden = setup(async () => {
      throw Object.assign(new Error("FORBIDDEN"), { data: { code: "FORBIDDEN" } });
    });
    forbidden.conn.start();
    await flush();
    expect(forbidden.conn.state).toBe("denied");

    let calls = 0;
    const flaky = setup(async () => {
      if (++calls === 1) throw new Error("netwerk");
      return { token: "jwt-ok", socketUrl: "wss://node1.test/ws" };
    });
    flaky.conn.start();
    await flush();
    expect(flaky.conn.state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1000);
    flaky.last().open();
    expect(flaky.last().sent).toEqual([{ event: "auth", token: "jwt-ok" }]);
  });

  it("stop() sluit de socket en verbindt niet opnieuw", async () => {
    const { conn, last } = setup();
    conn.start();
    await flush();
    const ws = last();
    ws.open();
    conn.stop();
    expect(ws.closedWith).toBe(1000);
    expect(conn.state).toBe("closed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("send() werkt alleen na auth_success", async () => {
    const { conn, last } = setup();
    conn.start();
    await flush();
    last().open();
    expect(conn.send({ event: "send_command", command: "list" })).toBe(false);
    last().push({ event: "auth_success" });
    expect(conn.send({ event: "send_command", command: "list" })).toBe(true);
    expect(last().sent.at(-1)).toEqual({ event: "send_command", command: "list" });
  });

  it("backoffDelay verdubbelt tot het maximum", () => {
    expect([0, 1, 2, 3, 10].map((a) => backoffDelay(a))).toEqual([1000, 2000, 4000, 8000, 30000]);
    expect(backoffDelay(3, { initialMs: 100, maxMs: 500 })).toBe(500);
  });
});

describe("MockSocket (mock-transport)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("doorloopt de refresh-flow: token_expiring → nieuw token → geen token_expired", async () => {
    let n = 0;
    const events: string[] = [];
    const conn = new ConsoleConnection({
      fetchToken: async () => ({ token: `jwt-${++n}`, socketUrl: "wss://node1.test/api/servers/x/ws" }),
      createSocket: (url) =>
        new MockSocket(url, { status: "online", permissions: [], memoryLimitBytes: 1 << 30, diskLimitBytes: 1 << 30, tokenLifetimeMs: 90_000 }),
      onMessage: (m) => events.push(m.event),
    });
    conn.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(conn.state).toBe("connected");
    expect(events).toContain("console_output"); // backlog
    expect(events).toContain("status");
    await vi.advanceTimersByTimeAsync(31_000); // token_expiring na 30 s
    expect(events).toContain("token_expiring");
    expect(n).toBe(2);
    await vi.advanceTimersByTimeAsync(80_000); // voorbij de oorspronkelijke vervaltijd
    expect(events).not.toContain("token_expired");
    expect(conn.state).toBe("connected");
    conn.stop();
  });

  it("zonder refresh sluit de mock met 4001 en verbindt de client opnieuw", async () => {
    let n = 0;
    const conn = new ConsoleConnection({
      fetchToken: async () => {
        n++;
        if (n === 2) throw new Error("refresh mislukt");
        return { token: `jwt-${n}`, socketUrl: "wss://node1.test/ws" };
      },
      createSocket: (url) => new MockSocket(url, { status: "offline", permissions: [], memoryLimitBytes: 1, diskLimitBytes: 1, tokenLifetimeMs: 61_000 }),
    });
    conn.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(conn.state).toBe("connected");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(conn.state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1100);
    expect(conn.state).toBe("connected");
    expect(n).toBe(3);
    conn.stop();
  });

  it("power en commando's in de mock", async () => {
    const out: string[] = [];
    const statuses: string[] = [];
    const conn = new ConsoleConnection({
      fetchToken: async () => ({ token: "t", socketUrl: "wss://node1.test/ws" }),
      createSocket: (url) => new MockSocket(url, { status: "offline", permissions: [], memoryLimitBytes: 1 << 30, diskLimitBytes: 1 << 30, speed: 100 }),
      onMessage: (m) => {
        if (m.event === "console_output") out.push(m.line ?? "");
        if (m.event === "status") statuses.push(m.state ?? "");
      },
    });
    conn.start();
    await vi.advanceTimersByTimeAsync(100);
    conn.send({ event: "set_state", state: "start" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(statuses).toEqual(["offline", "starting", "online"]);
    conn.send({ event: "send_command", command: "list" });
    expect(out.at(-1)).toMatch(/players online/);
    conn.stop();
  });
});

describe("isMockTransport", () => {
  it("mock alleen bij NEXT_PUBLIC_PANEL_MOCK=1, niet op een .test-host", () => {
    expect(isMockTransport("wss://node1.example.nl/ws", "1")).toBe(true);
    expect(isMockTransport("wss://node1.test/api/servers/x/ws", undefined)).toBe(false);
    expect(isMockTransport("wss://node1.example.nl/ws", undefined)).toBe(false);
  });
});
