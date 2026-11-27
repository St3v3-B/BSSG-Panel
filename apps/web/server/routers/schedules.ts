/** schedules.* (schedule.manage). */
import type { Implementation, Schedule } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { logActivity } from "../activity";
import { getDb, schema } from "../db";
import { validateCron } from "../lib/cron";
import { execute, nextRunAfter } from "../scheduler";
import { requireServer } from "../servers-data";

type Row = typeof schema.schedules.$inferSelect;
const ok = { ok: true as const };
const MAX_PER_SERVER = 50;

const toSchedule = (r: Row, serverUuid: string): Schedule => ({
  id: r.id,
  serverUuid,
  name: r.name,
  cron: r.cron,
  action: r.action,
  payload: r.payload,
  active: r.active,
  lastRunAt: r.lastRunAt,
  nextRunAt: r.nextRunAt,
  lastResult: r.lastResult,
});

function validate(i: { cron: string; action: string; payload: string | null }) {
  const err = validateCron(i.cron);
  if (err) throw new TRPCError({ code: "BAD_REQUEST", message: `INVALID_CRON: ${err}` });
  if (i.action === "command" && !i.payload?.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "COMMAND_REQUIRED" });
  if (i.payload && /[\r\n]/.test(i.payload)) throw new TRPCError({ code: "BAD_REQUEST", message: "COMMAND_MULTILINE" });
}

const payloadOf = (i: { action: string; payload: string | null }) => (i.action === "command" ? i.payload!.trim() : null);

async function scheduleFor(ctx: Parameters<typeof requireServer>[0], id: number) {
  const [r] = await getDb()
    .select({ s: schema.schedules, uuid: schema.servers.uuid })
    .from(schema.schedules)
    .innerJoin(schema.servers, eq(schema.servers.id, schema.schedules.serverId))
    .where(eq(schema.schedules.id, id));
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "SCHEDULE_NOT_FOUND" });
  const a = await requireServer(ctx, r.uuid, "schedule.manage");
  return { s: r.s, uuid: r.uuid, a };
}

export const schedules: Implementation["schedules"] = {
  list: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "schedule.manage");
    const rows = await getDb().select().from(schema.schedules).where(eq(schema.schedules.serverId, a.bundle.server.id)).orderBy(asc(schema.schedules.id));
    return rows.map((r) => toSchedule(r, input.uuid));
  },

  create: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "schedule.manage");
    validate(input);
    const existing = await getDb().select({ id: schema.schedules.id }).from(schema.schedules).where(eq(schema.schedules.serverId, a.bundle.server.id));
    if (existing.length >= MAX_PER_SERVER) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "TOO_MANY_SCHEDULES" });
    const [r] = await getDb()
      .insert(schema.schedules)
      .values({ serverId: a.bundle.server.id, name: input.name, cron: input.cron.trim(), action: input.action, payload: payloadOf(input), active: input.active, nextRunAt: input.active ? nextRunAfter(input.cron) : null })
      .returning();
    await logActivity({ action: "server.schedule.create", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { id: r!.id, name: r!.name, cron: r!.cron, action: r!.action }, ip: ctx.ip, ctx });
    return toSchedule(r!, input.uuid);
  },

  update: async ({ input, ctx }) => {
    const { s, uuid } = await scheduleFor(ctx, input.id);
    validate(input);
    const [r] = await getDb()
      .update(schema.schedules)
      .set({ name: input.name, cron: input.cron.trim(), action: input.action, payload: payloadOf(input), active: input.active, nextRunAt: input.active ? nextRunAfter(input.cron) : null })
      .where(eq(schema.schedules.id, s.id))
      .returning();
    await logActivity({ action: "server.schedule.update", userId: ctx.session!.userId, serverId: s.serverId, metadata: { id: s.id, name: input.name, cron: input.cron, active: input.active }, ip: ctx.ip, ctx });
    return toSchedule(r!, uuid);
  },

  delete: async ({ input, ctx }) => {
    const { s } = await scheduleFor(ctx, input.id);
    await getDb().delete(schema.schedules).where(eq(schema.schedules.id, s.id));
    await logActivity({ action: "server.schedule.delete", userId: ctx.session!.userId, serverId: s.serverId, metadata: { id: s.id, name: s.name }, ip: ctx.ip, ctx });
    return ok;
  },

  runNow: async ({ input, ctx }) => {
    const { s } = await scheduleFor(ctx, input.id);
    const result = await execute(s, ctx.session!.userId);
    if (result !== "ok") throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `SCHEDULE_FAILED: ${result.replace(/^error: /, "")}` });
    return ok;
  },
};
