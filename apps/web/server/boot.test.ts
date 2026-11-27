import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { boot, resetBoot } from "./boot";
import { getDb, schema } from "./db";
import { EnvError, parseEnv } from "./env";
import { decrypt, sha256 } from "./lib/crypto";
import { loadTemplatesFromDir } from "./templates";
import { GAME_TEMPLATE, OWNER, applyEnv, baseEnv, useHarness } from "./test/harness";

describe("env", () => {
  it("weigert test-login op een echt domein", () => {
    expect(() => parseEnv(baseEnv({ PANEL_DOMAIN: "panel.example.nl", DATABASE_URL: "postgres://x" }))).toThrow(EnvError);
    expect(() => parseEnv(baseEnv({ PANEL_DOMAIN: "panel.example.nl", PANEL_INSECURE_TEST_LOGIN: "0" }))).not.toThrow();
    expect(() => parseEnv(baseEnv())).not.toThrow();
  });
  it("vereist een sleutel van 32 bytes en een Discord-ID als eigenaar", () => {
    expect(() => parseEnv(baseEnv({ PANEL_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }))).toThrow(/PANEL_ENCRYPTION_KEY/);
    expect(() => parseEnv(baseEnv({ OWNER_DISCORD_ID: "abc" }))).toThrow(/OWNER_DISCORD_ID/);
    const { NODE_TOKEN: _n, ...rest } = baseEnv();
    expect(() => parseEnv(rest)).toThrow(/NODE_TOKEN/);
  });
  it("standaardwaarden voor URL's en poorten", () => {
    const e = parseEnv({ ...baseEnv(), PANEL_URL: "", DAEMON_URL: "", SFTP_PORT: "", DAEMON_PORT: "" });
    expect(e.PANEL_URL).toBe("https://panel.test");
    expect(e.DAEMON_URL).toBe("https://node1.test");
    expect(e.SFTP_PORT).toBe(2022);
    expect(e.DAEMON_PORT).toBe(8080);
  });
});

describe("boot", () => {
  const h = useHarness();

  it("zet eigenaar, lokale node, settings, JWT-sleutel en templates", async () => {
    const db = getDb();
    expect(await db.select().from(schema.adminDiscordIds)).toEqual([expect.objectContaining({ discordId: OWNER })]);
    const nodes = await db.select().from(schema.nodes);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ isLocal: true, fqdn: "node1.test", tokenHash: sha256(h.env.NODE_TOKEN!), sftpPort: 2222, daemonPort: 18080 });
    const keys = (await db.select().from(schema.settings)).map((s) => s.key).sort();
    expect(keys).toEqual(["accent_color", "activity_retention_days", "default_limits", "image_update_default_policy", "image_update_window", "jwt_signing_key_enc", "logo_url", "panel_name", "sleep_motd_promo", "sleep_motd_seed_logo", "sleep_motd_show_logo"]);
    const [k] = await db.select().from(schema.settings).where(eq(schema.settings.key, "jwt_signing_key_enc"));
    expect(decrypt(k!.value as string)).toContain("BEGIN PRIVATE KEY");
    expect((await db.select().from(schema.templates)).map((t) => t.slug).sort()).toEqual(["testgame", "testweb"]);
  });

  it("is idempotent en werkt de lokale node bij met nieuwe env", async () => {
    const db = getDb();
    const [before] = await db.select().from(schema.settings).where(eq(schema.settings.key, "jwt_signing_key_enc"));
    applyEnv({ ...h.env, NODE_DOMAIN: "node2.test", NODE_TOKEN: "x".repeat(40), SFTP_PORT: "2023" });
    resetBoot();
    await boot();
    resetBoot();
    await boot();
    const nodes = await db.select().from(schema.nodes);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ fqdn: "node2.test", tokenHash: sha256("x".repeat(40)), sftpPort: 2023 });
    expect(await db.select().from(schema.adminDiscordIds)).toHaveLength(1);
    const [after] = await db.select().from(schema.settings).where(eq(schema.settings.key, "jwt_signing_key_enc"));
    expect(after!.value).toEqual(before!.value);
    applyEnv(h.env);
    resetBoot();
    await boot();
  });

  it("templates: alleen bijwerken bij hogere versie, foute bestanden overslaan", async () => {
    const path = join(h.templatesDir, "game/testgame.yaml");
    writeFileSync(path, GAME_TEMPLATE.replace("name: Testspel", "name: Gewijzigd"));
    let r = await loadTemplatesFromDir(h.templatesDir);
    expect(r.unchanged).toContain("testgame");
    writeFileSync(path, GAME_TEMPLATE.replace("name: Testspel", "name: Gewijzigd").replace("version: 1", "version: 2"));
    writeFileSync(join(h.templatesDir, "game/kapot.yaml"), "schema: 1\nslug: kapot\n");
    writeFileSync(join(h.templatesDir, "game/verkeerd.yaml"), GAME_TEMPLATE.replace("slug: testgame", "slug: verkeerd").replace("type: game", "type: web"));
    r = await loadTemplatesFromDir(h.templatesDir);
    expect(r.updated).toEqual(["testgame"]);
    expect(r.errors).toHaveLength(2);
    const [t] = await getDb().select().from(schema.templates).where(eq(schema.templates.slug, "testgame"));
    expect(t).toMatchObject({ name: "Gewijzigd", version: 2 });
    expect(t!.variables.map((v) => v.key)).toEqual(["JAR_FILE", "SECRET_FLAG"]);
  });

  it("weigert te starten met test-login op een echt domein", async () => {
    applyEnv({ ...h.env, PANEL_DOMAIN: "panel.example.nl" });
    resetBoot();
    await expect(boot()).rejects.toThrow(/PANEL_INSECURE_TEST_LOGIN/);
    applyEnv(h.env);
    resetBoot();
    await boot();
  });
});
