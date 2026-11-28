/** Mock voor staging → productie (in-memory, alleen voor de UI). Stappen lopen op de klok, zoals de clone-mock. */
import { TRPCError } from "@trpc/server";
import type * as s from "../schemas";
import type { Implementation } from "../trpc-builder";

type I = Implementation["publish"];
type MockServer = { uuid: string; name: string; type: "game" | "web"; ownerId: number };

interface Deps {
  servers: () => MockServer[];
  id: () => number;
  /** servers.clone van de clone-mock (geeft de nieuwe uuid in `target`). */
  clone: (opts: Parameters<Implementation["servers"]["clone"]>[0]) => s.CloneJob | Promise<s.CloneJob>;
  hostOf: (uuid: string) => string | null;
}

const STEP_MS = 2000;
const err = (code: TRPCError["code"], message: string): never => {
  throw new TRPCError({ code, message });
};

export const MOCK_DEFAULT_EXCLUDES: s.PublishInfo["defaultExcludes"] = [
  { pattern: "wp-config.php", kind: "wp_config" },
  { pattern: ".env", kind: "env" },
  { pattern: "public/config/config.php", kind: "nextcloud_config" },
  { pattern: "public/config/panel.config.php", kind: "nextcloud_config" },
  { pattern: "/php/00-panel.ini", kind: "panel_settings" },
  { pattern: "/nginx/00-panel.conf", kind: "panel_settings" },
  { pattern: "/php/.disabled-extensions", kind: "panel_settings" },
  { pattern: "/.php/", kind: "php_runtime" },
  { pattern: "public/wp-content/uploads/", kind: "uploads" },
  { pattern: "/nextcloud-data/", kind: "user_data" },
];

export function createPublishMock(d: Deps): I {
  /** staging-uuid → productie-uuid */
  const stagingOf = new Map<string, string>();
  type Job = s.PublishJob & { startedMs: number };
  const jobs: Job[] = [];
  const srv = (uuid: string) => d.servers().find((x) => x.uuid === uuid) ?? err("NOT_FOUND", "SERVER_NOT_FOUND");

  const view = (j: Job): s.PublishJob => {
    const { startedMs: _s, ...rest } = j;
    if (j.status !== "running") return structuredClone(rest);
    const active = j.steps.filter((x) => x.status !== "skipped");
    const at = Math.floor((Date.now() - j.startedMs) / STEP_MS);
    if (at >= active.length) {
      j.status = "succeeded";
      j.finishedAt = new Date();
      for (const x of active) x.status = "done";
      return view(j);
    }
    active.forEach((x, i) => (x.status = i < at ? "done" : i === at ? "running" : "pending"));
    return structuredClone(rest);
  };

  return {
    info: ({ input }) => {
      const x = srv(input.uuid);
      const prodUuid = stagingOf.get(x.uuid);
      const prod = prodUuid ? d.servers().find((y) => y.uuid === prodUuid) : undefined;
      const stagings = [...stagingOf.entries()].filter(([, p]) => p === x.uuid).map(([st]) => d.servers().find((y) => y.uuid === st)).filter((y): y is MockServer => !!y);
      const running = jobs.find((j) => (j.staging.uuid === x.uuid || j.production.uuid === x.uuid) && view(j).status === "running");
      return {
        role: prod ? "staging" : stagings.length ? "production" : "none",
        isWeb: x.type === "web",
        production: prod ? { uuid: prod.uuid, name: prod.name, sameNode: true } : null,
        stagings: stagings.map((y) => ({ uuid: y.uuid, name: y.name, lastPublishedAt: jobs.find((j) => j.staging.uuid === y.uuid && j.status === "succeeded")?.finishedAt ?? null })),
        canPublish: !!prod && !running,
        reason: !prod ? "NOT_A_STAGING_SITE" : running ? "PUBLISH_IN_PROGRESS" : null,
        backupAvailable: false,
        databases: prod ? [{ from: `s${x.uuid.slice(0, 8)}_wordpress`, to: `s${prod.uuid.slice(0, 8)}_wordpress` }] : [],
        unmatchedDatabases: [],
        defaultExcludes: MOCK_DEFAULT_EXCLUDES,
        app: x.type === "web" ? "wordpress" : null,
        stagingHost: d.hostOf(x.uuid),
        productionHost: prod ? d.hostOf(prod.uuid) : null,
        notes: [],
        running: running ? view(running) : null,
      };
    },
    createStaging: async ({ input, ctx }) => {
      const x = srv(input.uuid);
      if (x.type !== "web") err("BAD_REQUEST", "NOT_A_WEBSITE");
      const job = await d.clone({ input: { uuid: x.uuid, name: input.name ?? `${x.name} (staging)`, copyDatabases: input.copyDatabases, domain: input.domain, startAfter: false }, ctx } as never);
      stagingOf.set(job.target.uuid, x.uuid);
      return job;
    },
    start: ({ input }) => {
      const x = srv(input.uuid);
      const prodUuid = stagingOf.get(x.uuid) ?? err("BAD_REQUEST", "NOT_A_STAGING_SITE");
      const prod = srv(prodUuid);
      if (!input.files && !input.databases) err("BAD_REQUEST", "NOTHING_TO_PUBLISH");
      if (input.databases && !input.confirmDatabases) err("BAD_REQUEST", "CONFIRM_DATABASES");
      if (!input.skipBackup) err("PRECONDITION_FAILED", "BACKUP_UNAVAILABLE");
      if (jobs.some((j) => (j.staging.uuid === x.uuid || j.production.uuid === prod.uuid) && view(j).status === "running")) err("CONFLICT", "PUBLISH_IN_PROGRESS");
      const exclude = input.exclude ?? MOCK_DEFAULT_EXCLUDES.map((e) => e.pattern);
      const step = (key: s.PublishStepKey, on: boolean) => ({ key, status: on ? ("pending" as const) : ("skipped" as const) });
      const from = d.hostOf(x.uuid);
      const to = d.hostOf(prod.uuid);
      const j: Job = {
        id: d.id(),
        status: "running",
        staging: { uuid: x.uuid, name: x.name, exists: true },
        production: { uuid: prod.uuid, name: prod.name, exists: true },
        steps: [step("backup", false), step("prepare", input.files), step("stop", true), step("files", input.files), step("databases", input.databases), step("start", true), step("finish", true)],
        options: { files: input.files, databases: input.databases, exclude, rewriteUrls: input.rewriteUrls, backup: false, sameNode: true },
        backupId: null,
        databases: input.databases ? [{ from: `s${x.uuid.slice(0, 8)}_wordpress`, to: `s${prod.uuid.slice(0, 8)}_wordpress` }] : [],
        kept: input.files ? ["/wp-config.php"] : [],
        urlRewrite: input.databases && input.rewriteUrls && from && to ? { from, to, replaced: 42, skipped: 0 } : null,
        warnings: ["No backup was made (no S3 target): you chose to continue without one."],
        restored: null,
        errorCode: null,
        error: null,
        startedAt: new Date(),
        finishedAt: null,
        startedMs: Date.now(),
      };
      jobs.unshift(j);
      return view(j);
    },
    job: ({ input }) => view(jobs.find((j) => j.id === input.id) ?? err("NOT_FOUND", "JOB_NOT_FOUND")),
    history: ({ input }) => jobs.filter((j) => j.staging.uuid === input.uuid || j.production.uuid === input.uuid).slice(0, 20).map(view),
  };
}
