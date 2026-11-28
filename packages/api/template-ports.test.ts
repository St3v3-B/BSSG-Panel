import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mapTemplatePorts, minTemplatePorts, pickTemplateAllocations, recommendedTemplatePorts } from "./template-ports";
import { parseTemplate, TemplatePort, type TemplateSpec } from "./template-schema";

const P = (x: Partial<TemplatePort> & { env: string }) => TemplatePort.parse(x);
const valheim = [P({ env: "SERVER_PORT", protocol: "udp" }), P({ env: "QUERY_PORT", protocol: "udp", offset: 1, exact: true })];
const rust = [
  P({ env: "SERVER_PORT", protocol: "udp" }),
  P({ env: "RCON_PORT", protocol: "tcp", offset: 1 }),
  P({ env: "QUERY_PORT", protocol: "udp", offset: 2 }),
  P({ env: "APP_PORT", protocol: "tcp", offset: 67, required: true }),
];
const ip = "203.0.113.10";

describe("mapTemplatePorts", () => {
  it("zonder ports: protocol van de allocation, standaard both", () => {
    const m = mapTemplatePorts([], [{ ip, port: 25565 }, { ip, port: 19132, protocol: "udp" }]);
    expect(m.allocations.map((a) => [a.port, a.protocol, a.primary])).toEqual([[25565, "both", true], [19132, "udp", false]]);
    expect(m.env).toEqual({});
  });

  it("exact: alleen primair + offset telt; anders niet gepubliceerd en env = primair + offset", () => {
    const ok = mapTemplatePorts(valheim, [{ ip, port: 2456 }, { ip, port: 2457 }]);
    expect(ok.allocations.map((a) => [a.port, a.protocol, a.env])).toEqual([[2456, "udp", "SERVER_PORT"], [2457, "udp", "QUERY_PORT"]]);
    expect(ok.env).toEqual({ QUERY_PORT: "2457" });
    const off = mapTemplatePorts(valheim, [{ ip, port: 2456 }, { ip, port: 2470, protocol: "tcp" }]);
    expect(off.allocations[1]).toMatchObject({ port: 2470, protocol: "tcp", env: null });
    expect(off.env).toEqual({ QUERY_PORT: "2457" });
    expect(off.missing).toEqual([]);
  });

  it("niet-exact: liefst primair + offset, anders de volgende vrije; verplicht zonder allocation → missing", () => {
    const m = mapTemplatePorts(rust, [{ ip, port: 28015 }, { ip, port: 28017 }, { ip, port: 29000 }]);
    expect(m.env).toEqual({ QUERY_PORT: "28017", RCON_PORT: "29000", APP_PORT: "28082" });
    expect(m.allocations.map((a) => a.protocol)).toEqual(["udp", "udp", "tcp"]);
    expect(m.missing).toEqual(["APP_PORT"]);
    expect(mapTemplatePorts(rust, []).missing).toEqual(["APP_PORT"]);
  });

  it("minimaal en aanbevolen aantal", () => {
    expect([minTemplatePorts(valheim), recommendedTemplatePorts(valheim)]).toEqual([1, 2]);
    expect([minTemplatePorts(rust), recommendedTemplatePorts(rust)]).toEqual([2, 4]);
    expect([minTemplatePorts([]), recommendedTemplatePorts([])]).toEqual([1, 1]);
  });
});

describe("pickTemplateAllocations", () => {
  const free = [2400, 2456, 2458, 2459, 2500].map((port, i) => ({ id: i + 1, ip, port }));
  it("kiest een primaire poort met primair + 1 vrij voor exact-poorten", () => {
    expect(pickTemplateAllocations(free, valheim, 2)!.map((a) => a.port)).toEqual([2458, 2459]);
    expect(pickTemplateAllocations(free, valheim, 1)!.map((a) => a.port)).toEqual([2400]);
    expect(pickTemplateAllocations(free, [], 2)!.map((a) => a.port)).toEqual([2400, 2456]);
    expect(pickTemplateAllocations(free, valheim, 6)).toBeNull();
    expect(pickTemplateAllocations(free, valheim, 0)).toEqual([]);
  });
  it("vult aan met de eerste vrije als offsets niet passen", () => {
    expect(pickTemplateAllocations(free, rust, 3)!.map((a) => a.port)).toEqual([2456, 2458, 2400]);
  });
});

describe("game-templates", () => {
  const dir = join(__dirname, "../../templates/game");
  const all = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => {
      const r = parseTemplate(readFileSync(join(dir, f), "utf8"));
      if (!r.ok) throw new Error(`${f}: ${r.errors.join("; ")}`);
      return [f, r.spec] as [string, TemplateSpec];
    });

  it("niet-lege defaults voldoen aan het patroon van hun variabele", () => {
    for (const [f, t] of all)
      for (const v of t.variables) if (v.pattern && v.default !== "") expect(new RegExp(`^(?:${v.pattern})$`).test(v.default), `${f} ${v.key}=${v.default}`).toBe(true);
  });

  it("Steam-games: poorten met protocol, aanbeveling, geen Minecraft-slaapstand", () => {
    const by = Object.fromEntries(all.map(([, t]) => [t.slug, t]));
    const proto = (slug: string) => by[slug]!.ports.map((p) => `${p.env}/${p.protocol}`);
    expect(proto("valheim")).toEqual(["SERVER_PORT/udp", "QUERY_PORT/udp"]);
    expect(by.valheim!.ports[1]).toMatchObject({ offset: 1, exact: true });
    expect(proto("satisfactory")).toEqual(["SERVER_PORT/both", "RELIABLE_PORT/tcp"]);
    expect(minTemplatePorts(by.satisfactory!.ports)).toBe(2);
    expect(proto("palworld")).toEqual(["SERVER_PORT/udp", "RCON_PORT/tcp"]);
    expect(proto("rust")).toEqual(["SERVER_PORT/udp", "RCON_PORT/tcp", "QUERY_PORT/udp", "APP_PORT/tcp"]);
    expect(proto("cs2")).toEqual(["SERVER_PORT/both", "TV_PORT/udp"]);
    expect(proto("terraria")).toEqual(["SERVER_PORT/tcp"]);
    for (const slug of ["valheim", "satisfactory", "palworld", "rust", "cs2", "terraria"]) {
      const t = by[slug]!;
      expect(t.sleep_capable, slug).toBe(false);
      expect(t.recommended?.memory_mb, slug).toBeGreaterThan(0);
      // Gebruikerstekst nooit via {{...}} in de shell-regel (alleen via "$VAR" uit de env).
      for (const v of t.variables) if (/NAME|PASSWORD|DESCRIPTION|MOTD|GSLT|WORLD_SEED/.test(v.key)) expect(t.startup, `${slug} ${v.key}`).not.toContain(`{{${v.key}}}`);
      if (slug !== "terraria") {
        expect(t.install.image, slug).toBe("steamcmd/steamcmd:debian-12");
        expect(t.install.script, slug).toMatch(/\+login anonymous \+app_update "\$APP" validate \+quit/);
      }
    }
    expect(by.cs2!.recommended!.disk_mb).toBeGreaterThanOrEqual(60 * 1024);
    expect(by.cs2!.description).toMatch(/35 GB/);
    // Valheim: wachtwoord minstens 5 tekens
    const pw = by.valheim!.variables.find((v) => v.key === "SERVER_PASSWORD")!;
    const re = new RegExp(`^(?:${pw.pattern})$`);
    expect([re.test("abcd"), re.test("abcde"), re.test("")]).toEqual([false, true, false]);
  });
});
