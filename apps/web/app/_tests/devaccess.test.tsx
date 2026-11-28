// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serverTabs } from "@/app/_components/server/server-tabs";
import { ApiKeysCard } from "@/app/_components/account/api-keys-card";
import { ApiDocs, groupEndpoints, schemaSketch, type OpenApiDoc } from "@/app/_components/developers/api-docs";
import { apiKeyName, metadataText } from "@/app/_components/admin/activity";
import { closeText, WebTerminal } from "@/app/_components/server/web-terminal";
import { TerminalAllowedSection, TerminalSettingsCard } from "@/app/_components/admin/terminal-toggles";
import { quickstart } from "@/app/_lib/api-examples";
import { getT } from "@/app/_lib/i18n";
import { TerminalSession, type TerminalSocket } from "@/app/_lib/terminal";
import { buildOpenApi } from "@/server/rest/openapi";
import { renderWithTrpc, sessionFor } from "./utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/", useParams: () => ({}), useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// xterm draait niet in jsdom: een nep-terminal die invoer en uitvoer bijhoudt.
const xt = vi.hoisted(() => ({ written: [] as string[], onData: null as null | ((d: string) => void) }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    onData(cb: (d: string) => void) {
      xt.onData = cb;
    }
    onResize() {}
    write(d: string | Uint8Array) {
      xt.written.push(typeof d === "string" ? d : new TextDecoder().decode(d));
    }
    reset() {
      xt.written.length = 0;
    }
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

beforeAll(() => {
  process.env.NEXT_PUBLIC_PANEL_MOCK = "1";
});
afterEach(cleanup);

const SITE = "c0ffee00-1234-4abc-8def-0123456789ab";
const inputs = (bodies: Array<{ path: string; input: unknown }>, p: string) => bodies.filter((b) => b.path === p).map((b) => b.input);

describe("terminal-tab", () => {
  const keys = (permissions: Parameters<typeof serverTabs>[0]["permissions"], enabled = true) =>
    serverTabs({ uuid: SITE, type: "web", isOwner: false, permissions, terminal: { enabled } }).map((x) => x.key);
  it("alleen met terminal + files.write en als de admin hem toestaat", () => {
    expect(keys(["terminal", "files.read", "files.write"])).toContain("terminal");
    expect(keys(["files.read", "files.write"])).not.toContain("terminal");
    expect(keys(["terminal", "files.read"])).not.toContain("terminal");
    expect(keys(["terminal", "files.read", "files.write"], false)).not.toContain("terminal");
  });
});

describe("API-sleutels (Account)", () => {
  it("sleutel maken beperkt tot één server, eenmalig tonen, intrekken", async () => {
    const { bodies } = renderWithTrpc(<ApiKeysCard />, { session: sessionFor("user") });
    expect(await screen.findByText("Nog geen API-sleutels.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("api-key-new"));
    const form = screen.getByTestId("api-key-form");
    fireEvent.change(within(form).getByLabelText("Naam"), { target: { value: "deploy" } });
    fireEvent.click(within(form).getByTestId("api-key-limit"));
    const submit = within(form).getByTestId("api-key-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // nog geen server gekozen
    const [box] = await within(form).findAllByTestId("api-key-server");
    fireEvent.click(box!);
    fireEvent.click(submit);
    expect((await screen.findByTestId("api-key-value")).textContent).toMatch(/^pk_mock1_/);
    const [input] = inputs(bodies, "account.createApiKey") as Array<{ name: string; permissions: string[]; serverUuids: string[]; expiresAt: Date | null }>;
    expect(input).toMatchObject({ name: "deploy", permissions: ["console.read", "files.read"], expiresAt: null });
    expect(input!.serverUuids).toHaveLength(1);
    const row = await screen.findByTestId("api-key-row");
    expect(row.textContent).toContain("1 server");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(within(row).getByTestId("api-key-revoke"));
    await waitFor(() => expect(inputs(bodies, "account.revokeApiKey")).toHaveLength(1));
    await screen.findByText("Nog geen API-sleutels.");
  });

  it("terminal aanvinken zet ook bestanden lezen en wijzigen aan", async () => {
    const { bodies } = renderWithTrpc(<ApiKeysCard />, { session: sessionFor("user"), locale: "en" });
    fireEvent.click(await screen.findByTestId("api-key-new"));
    const form = screen.getByTestId("api-key-form");
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "ssh" } });
    fireEvent.click(within(form).getByLabelText(/Terminal \(SSH\)/));
    fireEvent.click(within(form).getByTestId("api-key-submit"));
    await screen.findByTestId("api-key-value");
    const [input] = inputs(bodies, "account.createApiKey") as Array<{ permissions: string[]; serverUuids: string[] }>;
    expect(input!.permissions).toEqual(expect.arrayContaining(["terminal", "files.read", "files.write"]));
    expect(input!.serverUuids).toEqual([]);
  });
});

describe("API-documentatie", () => {
  const doc = buildOpenApi("https://panel.test") as unknown as OpenApiDoc;
  it("groepeert per tag en schetst schema's", () => {
    const g = groupEndpoints(doc);
    expect(g.map((x) => x.tag)).toEqual(["account", "servers", "files", "backups", "databases"]);
    expect(schemaSketch({ type: "object", properties: { a: { type: "string", format: "uuid" }, b: { type: "integer" } }, required: ["a"] })).toEqual({ a: "string (uuid)", "b?": "integer" });
  });

  it("rendert endpoints en voorbeelden met het eigen domein; taal wisselen", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } }));
    renderWithTrpc(<ApiDocs origin="https://panel.test" />, { session: sessionFor("user"), locale: "en" });
    expect(screen.getByTestId("api-base-url").textContent).toBe("https://panel.test/api/v1");
    expect(screen.getByTestId("api-example").textContent).toContain("curl -s -H \"Authorization: Bearer $PANEL_KEY\" https://panel.test/api/v1/servers");
    fireEvent.click(screen.getByRole("tab", { name: "Python" }));
    expect(screen.getByTestId("api-example").textContent).toContain('BASE = "https://panel.test/api/v1"');
    const eps = await screen.findAllByTestId("api-endpoint");
    expect(eps.map((e) => e.getAttribute("data-operation"))).toContain("powerServer");
    const power = eps.find((e) => e.getAttribute("data-operation") === "powerServer")!;
    expect(power.textContent).toContain("Permission: power");
    expect(power.textContent).toContain("Start, stop, restart or kill");
    expect(fetchSpy).toHaveBeenCalledWith("/api/v1/openapi.json");
    fetchSpy.mockRestore();
  });

  it("probeer het: GET met de geplakte sleutel, zonder cookies", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).endsWith("openapi.json") ? new Response(JSON.stringify(doc)) : new Response(JSON.stringify([{ uuid: SITE }]), { status: 200 }),
    );
    renderWithTrpc(<ApiDocs origin="https://panel.test" />, { session: sessionFor("user") });
    const eps = await screen.findAllByTestId("api-endpoint");
    const list = eps.find((e) => e.getAttribute("data-operation") === "listServers")!;
    fireEvent.change(screen.getByLabelText(/API-sleutel/), { target: { value: "geheim-sleutel" } });
    fireEvent.click(within(list).getByTestId("try-send"));
    expect(await within(list).findByText("Antwoord 200")).toBeTruthy();
    const call = fetchSpy.mock.calls.find(([u]) => String(u) === "/api/v1/servers")!;
    expect(call[1]).toMatchObject({ headers: { authorization: "Bearer geheim-sleutel" }, credentials: "omit" });
    fetchSpy.mockRestore();
  });

  it("voorbeelden in drie talen bevatten de basis-URL", () => {
    for (const l of ["curl", "python", "js"] as const) expect(quickstart("https://x.panel.test/", l)).toContain("https://x.panel.test/api/v1");
  });
});

describe("activiteitenlog: via API-sleutel", () => {
  it("toont de naam en laat de sleutelvelden uit de metadata weg", () => {
    const m = { path: "/a", method: "api_key", apiKeyId: 3, apiKeyName: "ci" };
    expect(apiKeyName(m)).toBe("ci");
    expect(metadataText(m)).toBe("path=/a");
    expect(apiKeyName({ path: "/a" })).toBeNull();
    expect(getT().devaccess.viaApiKey("ci")).toContain("ci");
  });
});

class FakeSocket implements TerminalSocket {
  readyState = 0;
  binaryType = "blob";
  sent: Array<string | Uint8Array> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  send(d: string | ArrayBufferLike | Uint8Array) {
    this.sent.push(typeof d === "string" ? d : new Uint8Array(d as ArrayBuffer));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  json(v: unknown) {
    this.onmessage?.({ data: JSON.stringify(v) });
  }
}

describe("TerminalSession", () => {
  it("auth met venstergrootte, binaire uitvoer/invoer, resize, token-refresh en exit", async () => {
    const sockets: FakeSocket[] = [];
    const out: string[] = [];
    const states: string[] = [];
    let closeInfo: unknown;
    const fetchToken = vi.fn(async (refresh: boolean) => ({ token: refresh ? "t2" : "t1", socketUrl: "wss://node1.test/api/servers/x/terminal" }));
    const s = new TerminalSession({
      fetchToken,
      createSocket: (u) => {
        const x = new FakeSocket(u);
        sockets.push(x);
        return x;
      },
      onOutput: (d) => out.push(new TextDecoder().decode(d)),
      onState: (st, info) => {
        states.push(st);
        if (st === "closed") closeInfo = info;
      },
    });
    await s.start(120, 40);
    const ws = sockets[0]!;
    expect(ws.binaryType).toBe("arraybuffer");
    ws.open();
    expect(JSON.parse(ws.sent[0] as string)).toEqual({ event: "auth", token: "t1", cols: 120, rows: 40 });
    s.write("ls\r"); // nog niet verbonden: genegeerd
    expect(ws.sent).toHaveLength(1);
    ws.json({ event: "auth_success" });
    expect(s.current).toBe("connected");
    ws.onmessage?.({ data: new TextEncoder().encode("$ ").buffer });
    expect(out).toEqual(["$ "]);
    s.write("ls\r");
    expect(new TextDecoder().decode(ws.sent[1] as Uint8Array)).toBe("ls\r");
    s.resize(100, 30);
    expect(JSON.parse(ws.sent[2] as string)).toEqual({ event: "resize", cols: 100, rows: 30 });
    ws.json({ event: "token_expiring", expires_at: "x" });
    await waitFor(() => expect(ws.sent.some((m) => typeof m === "string" && m.includes('"t2"'))).toBe(true));
    expect(fetchToken).toHaveBeenLastCalledWith(true);
    ws.json({ event: "terminal_exit", code: 0 });
    ws.close(1000);
    expect(states.at(-1)).toBe("closed");
    expect(closeInfo).toMatchObject({ code: 1000, exitCode: 0 });
    expect(closeText(getT().devaccess.terminal, { exitCode: 0 })).toContain("0");
    expect(closeText(getT().devaccess.terminal, { code: 4029 })).toBe(getT().devaccess.terminal.closedTooMany);
  });

  it("token ophalen mislukt → gesloten met de melding", async () => {
    let info: unknown;
    const s = new TerminalSession({
      fetchToken: async () => {
        throw new Error("Een beheerder heeft de terminal voor deze server uitgezet.");
      },
      createSocket: (u) => new FakeSocket(u),
      onOutput: () => {},
      onState: (st, i) => st === "closed" && (info = i),
    });
    await s.start(80, 24);
    expect(info).toMatchObject({ message: expect.stringContaining("uitgezet") });
  });
});

describe("WebTerminal (mock-transport)", () => {
  it("verbindt via servers.terminalToken, toont uitvoer en stuurt invoer", async () => {
    xt.written.length = 0;
    const { bodies } = renderWithTrpc(<WebTerminal uuid={SITE} />, { session: sessionFor("admin") });
    await waitFor(() => expect(screen.getByTestId("terminal-state").getAttribute("data-state")).toBe("connected"));
    expect(inputs(bodies, "servers.terminalToken")).toEqual([{ uuid: SITE, refresh: false }]);
    await waitFor(() => expect(xt.written.join("")).toContain("Mock terminal"));
    for (const ch of "pwd\r") xt.onData!(ch);
    await waitFor(() => expect(xt.written.join("")).toContain("/home/container"));
    for (const ch of "exit\r") xt.onData!(ch);
    expect((await screen.findByTestId("terminal-note")).textContent).toContain("exitcode 0");
  });

  it("uitgezet door de admin → melding, geen socket", async () => {
    renderWithTrpc(<WebTerminal uuid={SITE} />, {
      session: sessionFor("admin"),
      patch: (m) => {
        (m.servers as { terminalToken: unknown }).terminalToken = () => {
          throw Object.assign(new Error("TERMINAL_DISABLED"), { code: "FORBIDDEN" });
        };
      },
    });
    expect((await screen.findByTestId("terminal-note")).textContent).toBeTruthy();
  });
});

describe("admin: terminal-schakelaars", () => {
  it("per server en globaal", async () => {
    const { bodies } = renderWithTrpc(
      <>
        <TerminalAllowedSection uuid={SITE} allowed globalEnabled />
        <TerminalSettingsCard />
      </>,
      { session: sessionFor("admin") },
    );
    fireEvent.click(screen.getByTestId("terminal-allowed"));
    await waitFor(() => expect(inputs(bodies, "admin.servers.setTerminalAllowed")).toEqual([{ uuid: SITE, allowed: false }]));
    fireEvent.click(await screen.findByTestId("terminal-enabled"));
    await waitFor(() => expect(inputs(bodies, "admin.settings.update")).toEqual([{ terminalEnabled: false }]));
    await waitFor(() => expect(screen.getByTestId("terminal-settings").textContent).toContain("Geblokkeerd"));
  });
});
