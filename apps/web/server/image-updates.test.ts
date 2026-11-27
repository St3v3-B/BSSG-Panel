import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as reportImages } from "@/app/api/remote/node/images/route";
import { GET as imageSettings } from "@/app/api/remote/settings/image-updates/route";
import { POST as reportUpdate } from "@/app/api/remote/servers/[uuid]/image-update/route";
import { getDb, schema } from "./db";
import { GAME_TEMPLATE, OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
let admin: TestUser, player: TestUser, sub: TestUser;
let uuid = "";

const call = <T>(fn: (r: Request, c: { params: Promise<T> }) => Promise<Response>, path: string, body: unknown, params: T, token = h.env.NODE_TOKEN) =>
  fn(
    new Request(`http://panel.test${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
    { params: Promise.resolve(params) },
  );

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "290000000000000011", name: "speler" });
  sub = await h.user({ discordId: "290000000000000012", name: "helper" });
  void GAME_TEMPLATE;
  uuid = (
    await admin.api.admin.servers.create({
      name: "img", ownerId: player.id, nodeId: h.localNodeId, templateId: await h.templateId("testgame"),
      limits: { cpuPct: 100, ramMb: 1024, swapMb: 0, diskMb: 2048 }, allocationIds: [await h.allocation(25700)], variables: {}, startOnInstall: true,
    })
  ).uuid;
  await player.api.subusers.invite({ uuid, who: sub.discordId, permissions: ["power", "console.read"] });
});

describe("image-updates", () => {
  it("instellingen: standaard notify 04:00-05:00; admin kan ze wijzigen; daemon leest ze via remote", async () => {
    expect((await admin.api.admin.settings.get()).imageUpdates).toEqual({ defaultPolicy: "notify", windowStart: "04:00", windowEnd: "05:00" });
    const r = await call(imageSettings as never, "/api/remote/settings/image-updates", undefined, {});
    expect(await r.json()).toEqual({ default_policy: "notify", window_start: "04:00", window_end: "05:00", timezone: "Europe/Amsterdam" });
    expect((await call(imageSettings as never, "/api/remote/settings/image-updates", undefined, {}, "fout")).status).toBe(401);
    await admin.api.admin.settings.update({ imageUpdates: { defaultPolicy: "auto", windowStart: "03:30", windowEnd: "04:30" } });
    expect((await player.api.servers.get({ uuid })).imageUpdate).toMatchObject({ policy: null, effectivePolicy: "auto" });
    expect(await (await call(imageSettings as never, "/api/remote/settings/image-updates", undefined, {})).json()).toMatchObject({ default_policy: "auto", window_start: "03:30" });
    await expect(admin.api.admin.settings.update({ imageUpdates: { defaultPolicy: "auto", windowStart: "3:30", windowEnd: "04:30" } })).rejects.toThrow();
    await expect(player.api.admin.settings.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("spec bevat image_update met version_env uit de template", async () => {
    expect(h.daemon.servers.get(uuid)!.spec.image_update).toMatchObject({ version_env: null });
  });

  it("daemon-rapport: update beschikbaar zichtbaar voor eigenaar en admin-overzicht; foute server genegeerd", async () => {
    const at = new Date().toISOString();
    const other = "00000000-0000-4000-8000-000000000000";
    const res = await call(reportImages as never, "/api/remote/node/images", {
      servers: [
        { uuid, image: "example/game:1", current_image_id: "sha256:a", latest_image_id: "sha256:b", update_available: true, reinstall_required: false, checked_at: at },
        { uuid: other, image: "x", update_available: true, reinstall_required: false, checked_at: at },
      ],
    }, {});
    expect(res.status).toBe(204);
    const info = (await player.api.servers.get({ uuid })).imageUpdate;
    expect(info).toMatchObject({ available: true, reinstallRequired: false });
    expect(info.checkedAt).toBeInstanceOf(Date);
    expect((await player.api.servers.list()).find((s) => s.uuid === uuid)!.imageUpdate.available).toBe(true);
    const rows = await admin.api.admin.imageUpdates.list();
    expect(rows.find((r) => r.uuid === uuid)).toMatchObject({ image: "example/game:1", imageUpdate: { available: true } });
    await expect(player.api.admin.imageUpdates.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await call(reportImages as never, "/api/remote/node/images", { servers: [{ uuid: "geen-uuid" }] }, {})).status).toBe(400);
  });

  it("beleid: eigenaar zet auto → PUT met policy, DB, activiteit; subuser en vreemde waarde geweigerd", async () => {
    await player.api.servers.updateImagePolicy({ uuid, policy: "auto" });
    expect((h.daemon.last("PUT", `/api/servers/${uuid}`)!.body as { image_update: unknown }).image_update).toMatchObject({ policy: "auto" });
    expect((await player.api.servers.get({ uuid })).imageUpdate).toMatchObject({ policy: "auto", effectivePolicy: "auto" });
    // andere spec-wijziging houdt het beleid
    await admin.api.admin.servers.updateLimits({ uuid, limits: { cpuPct: 100, ramMb: 1024, swapMb: 0, diskMb: 4096 } });
    expect((h.daemon.last("PUT", `/api/servers/${uuid}`)!.body as { image_update: unknown }).image_update).toMatchObject({ policy: "auto" });
    await player.api.servers.updateImagePolicy({ uuid, policy: null });
    expect((h.daemon.last("PUT", `/api/servers/${uuid}`)!.body as { image_update: unknown }).image_update).toMatchObject({ policy: "default" });
    const log = (await admin.api.admin.activity.search({ serverUuid: uuid, action: "server.image.policy" })).items;
    expect(log.map((l) => l.metadata)).toEqual(expect.arrayContaining([{ policy: "auto" }, { policy: "default" }]));
    await expect(sub.api.servers.updateImagePolicy({ uuid, policy: "off" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(player.api.servers.updateImagePolicy({ uuid, policy: "soms" as never })).rejects.toThrow();
  });

  it("nu bijwerken: daemon-aanroep en activiteit; resultaat wist de melding en logt", async () => {
    await player.api.servers.updateImageNow({ uuid });
    expect(h.daemon.last("POST", `/api/servers/${uuid}/image-update`)).toBeTruthy();
    await expect(sub.api.servers.updateImageNow({ uuid })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const res = await call(reportUpdate as never, `/api/remote/servers/${uuid}/image-update`, { successful: true, mode: "manual", from_image_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaa", to_image_id: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, { uuid });
    expect(res.status).toBe(204);
    expect((await player.api.servers.get({ uuid })).imageUpdate.available).toBe(false);
    await call(reportUpdate as never, `/api/remote/servers/${uuid}/image-update`, { successful: false, mode: "auto", error: "pull faalde" }, { uuid });
    const actions = (await admin.api.admin.activity.search({ serverUuid: uuid })).items.map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["server.image.update.requested", "server.image.update.manual", "server.image.update.failed"]));
    expect((await call(reportUpdate as never, "/x", { successful: true, mode: "auto" }, { uuid: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
  });

  it("admin checkNow roept de daemon aan", async () => {
    await admin.api.admin.imageUpdates.checkNow();
    expect(h.daemon.last("POST", "/api/images/check")).toBeTruthy();
    const [row] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid));
    expect(row!.imageUpdatePolicy).toBeNull();
  });
});
