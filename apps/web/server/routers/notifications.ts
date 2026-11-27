/** Discord-webhooks en auto-restart: account, server (eigenaar) en admin-breed. */
import type { Implementation } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { logActivity } from "../activity";
import { forbidApiKey } from "../apikey";
import { call, daemonFor } from "../daemon";
import { getDb, schema } from "../db";
import { getAdminHook, getUserHook, hookStatus, sendTest, serverHookOf, setAdminHook, setUserHook } from "../notify";
import { encrypt } from "../lib/crypto";
import { requireServer } from "../servers-data";
import { currentSpec } from "./servers";

const ok = { ok: true as const };
const failed = () => new TRPCError({ code: "BAD_REQUEST", message: "WEBHOOK_FAILED" });
const noHook = () => new TRPCError({ code: "BAD_REQUEST", message: "NO_WEBHOOK" });

export const notificationsAccount: Pick<Implementation["account"], "webhook" | "setWebhook" | "testWebhook"> = {
  webhook: async ({ ctx }) => hookStatus(await getUserHook(ctx.session!.userId)),
  setWebhook: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    await setUserHook(ctx.session!.userId, input.url);
    await logActivity({ action: input.url ? "account.webhook.set" : "account.webhook.remove", userId: ctx.session!.userId, ip: ctx.ip, ctx });
    return hookStatus(input.url);
  },
  testWebhook: async ({ ctx }) => {
    forbidApiKey(ctx);
    const url = await getUserHook(ctx.session!.userId);
    if (!url) throw noHook();
    if (!(await sendTest(url, "your account notifications"))) throw failed();
    return ok;
  },
};

export const notificationsServer: Pick<Implementation["servers"], "notifications" | "updateNotifications" | "testWebhook"> = {
  notifications: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "owner");
    const s = a.bundle.server;
    return { webhook: hookStatus(serverHookOf(s)), autoRestart: s.autoRestart, autoRestartMax: s.autoRestartMax };
  },
  updateNotifications: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const a = await requireServer(ctx, input.uuid, "owner", { mutates: true });
    const b = a.bundle;
    const next = { ...b.server, autoRestart: input.autoRestart, autoRestartMax: input.autoRestartMax };
    if (next.autoRestart !== b.server.autoRestart || next.autoRestartMax !== b.server.autoRestartMax) {
      await call(async () => daemonFor(b.node).updateServer(b.server.uuid, await currentSpec({ ...b, server: next }, { skipInstall: true })));
    }
    const set: Partial<typeof schema.servers.$inferInsert> = { autoRestart: input.autoRestart, autoRestartMax: input.autoRestartMax };
    if (input.webhookUrl !== undefined) set.discordWebhookEnc = input.webhookUrl ? encrypt(input.webhookUrl) : null;
    const [row] = await getDb().update(schema.servers).set(set).where(eq(schema.servers.id, b.server.id)).returning();
    await logActivity({
      action: "server.notifications.update",
      userId: ctx.session!.userId,
      serverId: b.server.id,
      metadata: { autoRestart: input.autoRestart, autoRestartMax: input.autoRestartMax, ...(input.webhookUrl !== undefined ? { webhook: input.webhookUrl ? "set" : "removed" } : {}) },
      ip: ctx.ip,
      ctx,
    });
    return { webhook: hookStatus(serverHookOf(row!)), autoRestart: row!.autoRestart, autoRestartMax: row!.autoRestartMax };
  },
  testWebhook: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const a = await requireServer(ctx, input.uuid, "owner");
    const url = serverHookOf(a.bundle.server);
    if (!url) throw noHook();
    if (!(await sendTest(url, `notifications for ${a.bundle.server.name}`))) throw failed();
    return ok;
  },
};

export const notificationsAdmin: Implementation["admin"]["notifications"] = {
  get: async () => hookStatus(await getAdminHook()),
  set: async ({ input, ctx }) => {
    await setAdminHook(input.url);
    await logActivity({ action: "admin.webhook.update", userId: ctx.session!.userId, metadata: { webhook: input.url ? "set" : "removed" }, ip: ctx.ip, ctx });
    return hookStatus(input.url);
  },
  test: async () => {
    const url = await getAdminHook();
    if (!url) throw noHook();
    if (!(await sendTest(url, "admin notifications"))) throw failed();
    return ok;
  },
};
