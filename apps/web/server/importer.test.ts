import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { waitImports } from "./importer/router";
import { eggToTemplateYaml, mapVariables, rulesToPattern, scoreTemplate } from "./importer/mapping";
import { parseTar, tarStream, type TarEntry } from "./importer/tar";
import { FakePtero, tarGz } from "./test/fake-ptero";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
let admin: TestUser, player: TestUser, steve: TestUser;
const ptero = new FakePtero();

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "291500000000000009", name: "speler" });
  steve = await h.user({ discordId: "291500000000000001", name: "steve-panel" });
  ptero.seed();
  await ptero.start();
  // Survival: backup in de bron. Creatief en TS3: via SFTP.
  ptero.backups.set("a1b2c3d4", [
    { uuid: "0b0b0b0b-1111-4000-8000-000000000001", is_successful: false, is_locked: false, name: "kapot", ignored_files: [], checksum: null, bytes: 0, created_at: "2026-11-27T10:00:00+00:00", completed_at: "2026-11-27T10:01:00+00:00" },
    { uuid: "0b0b0b0b-1111-4000-8000-000000000002", is_successful: true, is_locked: false, name: "nachtelijk", ignored_files: [], checksum: "sha1:x", bytes: 1234, created_at: "2026-11-27T03:00:00+00:00", completed_at: "2026-11-27T03:02:00+00:00" },
  ]);
  ptero.backupFiles.set("0b0b0b0b-1111-4000-8000-000000000002", await tarGz({ files: new Map([["world/level.dat", Buffer.from("wereld-uit-backup")], ["server.properties", Buffer.from("motd=hoi\n")]]), dirs: new Set(["world"]) }));
  ptero.trees.set("b2c3d4e5", { files: new Map([["/plugins/x.jar", Buffer.alloc(70_000, 7)], ["/" + "lang/".repeat(25) + "nl.yml", Buffer.from("taal: nl")]]), dirs: new Set(["/plugins", ...Array.from({ length: 25 }, (_, i) => "/" + "lang/".repeat(i + 1).replace(/\/$/, ""))]) });
  for (const p of [25565, 25566, 30001, 30002]) await h.allocation(p, "0.0.0.0");
});
afterAll(async () => {
  await ptero.stop();
});

const connect = (o: Partial<{ apiKey: string; kind: "pterodactyl" | "pelican"; clientApiKey: string | null; sftp: boolean }> = {}) =>
  admin.api.admin.importer.connect({
    kind: o.kind ?? "pterodactyl",
    url: `${ptero.url}/`,
    apiKey: o.apiKey ?? ptero.appKey,
    clientApiKey: o.clientApiKey === undefined ? ptero.clientKey : o.clientApiKey,
    sftp: o.sftp === false ? null : { username: ptero.sftpUser, password: ptero.sftpPassword, host: "127.0.0.1", port: ptero.sftpPort },
  });
const counts = async () => {
  const db = getDb();
  const [s] = await db.select({ n: count() }).from(schema.servers);
  const [u] = await db.select({ n: count() }).from(schema.users);
  const [t] = await db.select({ n: count() }).from(schema.templates);
  return { servers: s!.n, users: u!.n, templates: t!.n, daemon: h.daemon.servers.size };
};

describe("import: mapping (eenheden)", () => {
  it("scoort templates op naam, image, startup en variabelen; Laravel-regels naar patronen", () => {
    const egg = { id: 1, nestName: null, name: "Paper", description: "", dockerImages: ["ghcr.io/pterodactyl/yolks:java_21"], startup: "java -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}", stop: "stop", done: [], configFiles: {}, install: { script: "", container: "", entry: "ash" }, variables: [{ key: "MINECRAFT_VERSION", name: "v", description: "", default: "", userEditable: true, rules: "" }] };
    const paper = { id: 1, slug: "paper", name: "Paper", type: "game" as const, image: "eclipse-temurin:21-jre", startup: "java -Xmx{{SERVER_MEMORY}}M -jar paper.jar", variables: [{ key: "MINECRAFT_VERSION" }] };
    const node = { id: 2, slug: "node-generic", name: "Node.js", type: "game" as const, image: "node:22", startup: "node index.js", variables: [] };
    expect(scoreTemplate(egg, paper).score).toBeGreaterThanOrEqual(60);
    expect(scoreTemplate(egg, paper).reasons).toEqual(expect.arrayContaining(["name", "variables"]));
    expect(scoreTemplate(egg, node).score).toBeLessThan(20);
    expect(rulesToPattern("required|string|in:a,b.c")).toBe("^(a|b\\.c)$");
    expect(rulesToPattern("nullable|integer")).toBe("^(-?\\d+)?$");
    expect(rulesToPattern("required|regex:/^[0-9]+$/")).toBe("^[0-9]+$");
    expect(rulesToPattern("required|string|max:20")).toBeUndefined();
    expect(mapVariables({ JAR_FILE: "x.jar", OTHER: "1", "bad-key": "y" }, { variables: [{ key: "JAR_FILE", pattern: "^[a-z.]+\\.jar$" }] })).toEqual({ values: { JAR_FILE: "x.jar" }, dropped: ["OTHER", "bad-key"], invalid: [] });
  });

  it("tar met lange paden is terug te lezen", async () => {
    const long = `${"a".repeat(60)}/${"b".repeat(60)}/c.txt`;
    async function* e(): AsyncGenerator<TarEntry> {
      yield { type: "dir", path: "a" };
      yield { type: "file", path: long, size: 5, open: async function* () { yield new TextEncoder().encode("hallo-extra"); } };
      yield { type: "file", path: "kort.txt", size: 4, open: async function* () { yield new TextEncoder().encode("ab"); } };
      yield { type: "file", path: "../ontsnapt", size: 1, open: async function* () { yield new Uint8Array(1); } };
    }
    const buf = Buffer.from(await new Response(tarStream(e())).arrayBuffer());
    const t = parseTar(buf);
    expect(new TextDecoder().decode(t.files.get(`/${long}`))).toBe("hallo"); // afgekapt op de aangekondigde grootte
    expect([...t.files.get("/kort.txt")!]).toEqual([97, 98, 0, 0]); // aangevuld
    expect(t.files.has("/../ontsnapt")).toBe(false);
    expect(t.dirs.has("/a")).toBe(true);
  });
});

describe("admin.importer", () => {
  it("foute sleutel of URL: duidelijke fout; niet-admin mag niet", async () => {
    await expect(connect({ apiKey: "ptla_fout_fout" })).rejects.toThrow(/SOURCE_UNAUTHORIZED/);
    await expect(admin.api.admin.importer.connect({ kind: "pterodactyl", url: "http://127.0.0.1:1", apiKey: "ptla_xxxxxxxx", clientApiKey: null, sftp: null })).rejects.toThrow(/SOURCE_UNREACHABLE/);
    await expect(player.api.admin.importer.get()).rejects.toThrow(/NOT_ADMIN/);
    expect(await admin.api.admin.importer.get()).toBeNull();
  });

  it("connect leest alles (met paginering) en stelt een mapping voor; sleutels versleuteld", async () => {
    const s = await connect();
    expect(s.users.map((u) => u.username)).toEqual(["steve", "kees", "zonderdiscord"]);
    expect(s.eggs.map((e) => [e.name, e.nestName, e.action])).toEqual([["Testspel", "Minecraft", "template"], ["Teamspeak3 Server", "Voice Servers", "skip"]]);
    expect(s.eggs[0]!.templateId).toBe(await h.templateId("testgame"));
    expect(s.eggs[0]!.suggestion!.score).toBeGreaterThanOrEqual(80);
    expect(s.servers).toHaveLength(3);
    expect(s.servers[0]).toMatchObject({ name: "Survival", identifier: "a1b2c3d4", allocations: [{ ip: "203.0.113.5", port: 25565, primary: true }], variables: { JAR_FILE: "paper.jar", BUILD_NUMBER: "120" }, status: "pending" });
    // steve staat met zijn Discord-ID (external_id) al in het panel; kees en de derde niet
    expect(s.users[0]).toMatchObject({ action: "link", accountId: steve.id, matchedBy: "discord" });
    expect(s.users[1]).toMatchObject({ action: "skip" });
    expect(s.defaultNodeId).toBe(h.localNodeId);
    expect(s).toMatchObject({ connected: true, hasClientKey: true, sftpUsername: "steve", state: "ready" });
    const [row] = await getDb().select().from(schema.importSessions);
    expect(JSON.stringify(row)).not.toContain(ptero.appKey);
    expect(JSON.stringify(row)).not.toContain(ptero.sftpPassword);
    expect(ptero.writes()).toEqual([]);
    expect(ptero.requests.some((r) => r.path.startsWith("/api/application/users?page=2"))).toBe(true); // 3 gebruikers, 2 per pagina
  });

  it("dry-run toont wat er zou gebeuren en schrijft niets", async () => {
    const before = await counts();
    const plan = await admin.api.admin.importer.dryRun();
    expect(await counts()).toEqual(before);
    const by = (n: string) => plan.servers.find((x) => x.name === n)!;
    expect(by("Survival")).toMatchObject({ owner: "steve-panel", template: "Testspel", ports: [25565], method: "backup", blocked: null, variables: { JAR_FILE: "paper.jar" }, droppedVariables: ["BUILD_NUMBER"] });
    expect(by("Survival").warnings.join(" ")).toMatch(/unlimited RAM/);
    expect(by("Creatief").blocked).toMatch(/owner kees is skipped/);
    expect(by("TS3").blocked).toMatch(/owner kees is skipped/);
    expect(plan.createUsers).toEqual([]);
    expect(ptero.writes()).toEqual([]);
  });

  it("mapping aanpassen: kees vooraf aanmaken, onbekende egg omzetten naar een nieuwe template", async () => {
    await expect(admin.api.admin.importer.setMapping({ users: [{ id: 2, action: "create", accountId: null, discordId: null }] })).rejects.toThrow(/DISCORD_ID_REQUIRED/);
    await admin.api.admin.importer.setMapping({ users: [{ id: 2, action: "create", accountId: null, discordId: "291500000000000002" }] });
    expect((await admin.api.admin.importer.dryRun()).servers.find((x) => x.name === "TS3")!.blocked).toMatch(/not mapped to a template/);
    const conv = await admin.api.admin.importer.convertEgg({ eggId: 7 });
    expect(conv.errors).toEqual([]);
    expect(conv.yaml).toMatch(/slug: egg-teamspeak3-server/);
    expect(conv.yaml).toMatch(/value: SIGINT/);
    expect(conv.yaml).toMatch(/key: QUERY_PORT/);
    expect(conv.yaml).toContain("cd /home/container");
    expect(conv.yaml).toMatch(/ini\) is not supported/);
    const tpl = await admin.api.admin.templates.create({ yaml: conv.yaml });
    await admin.api.admin.importer.setMapping({ eggs: [{ id: 7, action: "template", templateId: tpl.id }] });
    const plan = await admin.api.admin.importer.dryRun();
    expect(plan.createUsers).toEqual([{ sourceId: 2, username: "kees", discordId: "291500000000000002" }]);
    const ts = plan.servers.find((x) => x.name === "TS3")!;
    expect(ts.blocked).toBeNull();
    expect(ts.method).toBe("sftp");
    expect(ts.ports).toEqual([30001]); // 9987 is hier niet vrij
    expect(ts.warnings.join(" ")).toMatch(/9987 not free/);
    expect(plan.servers.find((x) => x.name === "Creatief")).toMatchObject({ owner: "new account 291500000000000002 (kees)", ports: [25566], method: "sftp" });
  });

  it("start: één voor één, backup en SFTP, fout → overgeslagen opruimen en hervatten; bron ongewijzigd", async () => {
    const s = await admin.api.admin.importer.start();
    expect(s.state).toBe("running");
    await expect(admin.api.admin.importer.start()).rejects.toThrow(/IMPORT_RUNNING/);
    await waitImports();
    let cur = (await admin.api.admin.importer.get())!;
    const st = (n: string) => cur.servers.find((x) => x.name === n)!;
    expect(st("Survival")).toMatchObject({ status: "done", method: "backup" });
    expect(st("Creatief")).toMatchObject({ status: "done", method: "sftp" });
    expect(st("Creatief").bytes).toBeGreaterThan(70_000);
    // TS3 heeft geen SFTP-map in de bron: login mislukt → failed, niets blijft achter
    expect(st("TS3").status).toBe("failed");
    expect(st("TS3").error).toMatch(/SFTP_FAILED/);
    expect(cur.state).toBe("ready");
    expect(cur.connected).toBe(true);

    const surv = h.daemon.fs(st("Survival").newUuid!);
    expect(surv.files.get("/world/level.dat")).toBe("wereld-uit-backup");
    expect(h.daemon.servers.get(st("Survival").newUuid!)!.spec.skip_install).toBe(true);
    const crea = h.daemon.fs(st("Creatief").newUuid!);
    expect(crea.files.get("/plugins/x.jar")!.length).toBe(70_000);
    expect(crea.files.get("/" + "lang/".repeat(25) + "nl.yml")).toBe("taal: nl");
    const db = getDb();
    const [survRow] = await db.select().from(schema.servers).where(eq(schema.servers.uuid, st("Survival").newUuid!));
    expect(survRow).toMatchObject({ ownerId: steve.id, ramMb: 1024, cpuPct: 150, diskMb: 5000, status: "offline" });
    const [kees] = await db.select().from(schema.users).where(eq(schema.users.discordId, "291500000000000002"));
    expect(kees).toMatchObject({ name: "kees", email: "kees@panel.test", emailVerifiedAt: null });
    const vars = await db.select().from(schema.serverVariables).where(eq(schema.serverVariables.serverId, survRow!.id));
    expect(vars).toEqual([{ serverId: survRow!.id, key: "JAR_FILE", value: "paper.jar" }]);
    const ts3Rows = await db.select().from(schema.servers).where(eq(schema.servers.name, "TS3"));
    expect(ts3Rows).toEqual([]);

    // hervatten na het oplossen van de oorzaak
    ptero.trees.set("c3d4e5f6", { files: new Map([["/ts3server.ini", Buffer.from("x=1")]]), dirs: new Set() });
    const before = h.daemon.servers.size;
    await admin.api.admin.importer.start();
    await waitImports();
    cur = (await admin.api.admin.importer.get())!;
    expect(cur.servers.map((x) => x.status)).toEqual(["done", "done", "done"]);
    expect(h.daemon.servers.size).toBe(before + 1); // alleen TS3 opnieuw
    // klaar zonder fouten: sleutels gewist
    expect(cur.state).toBe("done");
    expect(cur.connected).toBe(false);
    const [row] = await db.select().from(schema.importSessions);
    expect(row).toMatchObject({ apiKeyEnc: null, clientKeyEnc: null, sftp: null });
    await expect(admin.api.admin.importer.start()).rejects.toThrow(/NOT_CONNECTED/);
    // de bron is alleen gelezen
    expect(ptero.writes()).toEqual([]);
    const log = await admin.api.admin.activity.search({ action: "admin.import.server" });
    expect(log.items).toHaveLength(3);
  });

  it("Pelican: eggs zonder nests; disconnect vergeet alles", async () => {
    ptero.kind = "pelican";
    const s = await connect({ kind: "pelican", clientApiKey: null, sftp: false });
    expect(s.eggs.map((e) => [e.name, e.nestName])).toEqual([["Testspel", null], ["Teamspeak3 Server", null]]);
    expect(ptero.requests.some((r) => r.path.startsWith("/api/application/eggs?include=variables"))).toBe(true);
    const plan = await admin.api.admin.importer.dryRun();
    expect(plan.servers.find((x) => x.name === "Survival")!.method).toBe("none");
    await admin.api.admin.importer.disconnect();
    expect(await admin.api.admin.importer.get()).toBeNull();
    expect(await getDb().select().from(schema.importSessions)).toEqual([]);
    expect(ptero.writes()).toEqual([]);
  });

  it("eggToTemplateYaml: bash-installscript, placeholders en done-teksten", () => {
    const r = eggToTemplateYaml(
      { id: 1, nestName: null, name: "My Egg", description: "d", dockerImages: ["a:1", "b:2"], startup: "./run {{SERVER_PORT}}", stop: "stop", done: ["Done (", "ready!"], configFiles: { "c.yml": { parser: "yaml", find: { "a.b": "{{server.build.env.MY_VAR}}", "list[0]": "x" } } }, install: { script: "cd /mnt/server", container: "debian", entry: "bash" }, variables: [{ key: "my-var", name: "My var", description: "", default: "1", userEditable: false, rules: "required|boolean" }, { key: "SERVER_MEMORY", name: "mem", description: "", default: "1", userEditable: false, rules: "" }] },
      "pterodactyl",
    );
    expect(r.errors).toEqual([]);
    expect(r.yaml).toContain("exec bash /tmp/egg-install.sh");
    expect(r.yaml).toContain('a.b: "{{MY_VAR}}"');
    expect(r.yaml).toContain("ready_pattern: Done \\(|ready!");
    expect(r.notes.join("\n")).toMatch(/SERVER_MEMORY is built in/);
    expect(r.notes.join("\n")).toMatch(/list\[0\]/);
    expect(r.notes.join("\n")).toMatch(/2 images/);
  });
});
