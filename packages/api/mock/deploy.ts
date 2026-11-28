/** Mock voor git-deploy van websites: een gekoppelde repo met geschiedenis en een nep-deploy van ~8 s. */
import { TRPCError } from "@trpc/server";
import type * as s from "../schemas";
import type { Implementation } from "../trpc-builder";

type I = Implementation["deploy"];
const ok = { ok: true as const };

interface Deps {
  servers: () => Array<{ uuid: string; type: s.ServerType; templateSlug: string }>;
  nextId: () => number;
  userName: (uid: number) => string | null;
}

const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockMockMockMockMockMockMockMockMockMock panel-deploy-c0ffee00";
const SHA = "3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39";

const LOG = [
  "Fetching https://github.com/blokgenoten/site.git (branch main)",
  "From https://github.com/blokgenoten/site",
  " * [new branch]      main       -> refs/panel/deploy",
  "Fetched.",
  "Commit 3f2a9c1d by Ada Lovelace: Nieuwe header en footer",
  "$ npm ci && npm run build",
  "added 214 packages in 6s",
  "> site@1.0.0 build",
  "> vite build",
  "✓ 48 modules transformed.",
  "dist/index.html  1.2 kB",
  "Publishing to /public",
  "kept /.env",
  "Deploy finished.",
];

export function createDeployMock(d: Deps): I {
  const now = Date.now();
  const web = d.servers().find((x) => x.type === "web");
  const configs = new Map<string, s.DeployConfig>();
  const history: Array<s.Deploy & { log: string[] }> = [];
  const webroot = (_uuid: string) => "/public";
  const base = (uuid: string): s.DeployConfig => ({
    configured: false,
    canManage: true,
    repoUrl: null,
    branch: "main",
    authType: "none",
    tokenSet: false,
    tokenUsername: null,
    targetDir: webroot(uuid),
    defaultTargetDir: webroot(uuid),
    sourceDir: "/",
    buildCommand: null,
    buildImage: "site",
    sharedPaths: [],
    restartAfter: false,
    autoDeploy: true,
    sshPublicKey: null,
    sshHost: null,
    webhookUrl: null,
    webhookSecret: null,
  });
  if (web) {
    configs.set(web.uuid, {
      ...base(web.uuid),
      configured: true,
      repoUrl: "https://github.com/blokgenoten/site.git",
      buildCommand: "npm ci && npm run build",
      buildImage: "node:22-alpine",
      sourceDir: "/dist",
      sharedPaths: ["/.env"],
      webhookUrl: "https://panel.test/api/deploy/webhook/mock-hook-id",
      webhookSecret: "mock-webhook-secret-0123456789",
    });
    const mk = (i: number, status: s.DeployStatus, msg: string, trigger: "manual" | "webhook", mins: number, error: string | null = null) => {
      const startedAt = new Date(now - mins * 60_000);
      history.push({
        id: i,
        serverUuid: web.uuid,
        status,
        trigger,
        branch: "main",
        commitSha: SHA.slice(i) + SHA.slice(0, i),
        commitAuthor: "Ada Lovelace",
        commitMessage: msg,
        commitDate: new Date(startedAt.getTime() - 60_000),
        triggeredBy: trigger === "manual" ? "steve" : null,
        error,
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 41_000),
        durationMs: 41_000,
        log: status === "failed" ? [...LOG.slice(0, 7), "npm ERR! Missing script: \"build\"", `Deploy failed: ${error}`] : LOG,
      });
    };
    mk(3, "succeeded", "Nieuwe header en footer", "webhook", 35);
    mk(2, "failed", "Build-script hernoemd", "webhook", 3 * 60, "build command exited with code 1");
    mk(1, "succeeded", "Eerste versie", "manual", 26 * 60);
  }
  const need = (uuid: string) => {
    const x = d.servers().find((y) => y.uuid === uuid);
    if (!x) throw new TRPCError({ code: "NOT_FOUND", message: "server" });
    if (x.type !== "web") throw new TRPCError({ code: "BAD_REQUEST", message: "NOT_A_WEBSITE" });
    return configs.get(uuid) ?? base(uuid);
  };
  // Nep-voortgang: een lopende deploy loopt 8 s en is dan geslaagd.
  const advance = (x: s.Deploy & { log: string[] }) => {
    if (x.status !== "running") return x;
    const elapsed = Date.now() - x.startedAt.getTime();
    x.log = LOG.slice(0, Math.min(LOG.length - 1, Math.floor(elapsed / 600) + 1));
    if (elapsed >= 8_000) Object.assign(x, { status: "succeeded", log: LOG, finishedAt: new Date(), durationMs: elapsed, commitSha: SHA, commitAuthor: "Ada Lovelace", commitMessage: "Nieuwe header en footer", commitDate: new Date(now - 10 * 60_000) });
    return x;
  };
  const strip = ({ log: _l, ...rest }: s.Deploy & { log: string[] }): s.Deploy => rest;
  const find = (id: number) => {
    const x = history.find((h) => h.id === id);
    if (!x) throw new TRPCError({ code: "NOT_FOUND", message: "DEPLOY_NOT_FOUND" });
    return advance(x);
  };
  const ssh = (url: string) => /^(ssh:\/\/|[A-Za-z0-9._-]+@)/.test(url);
  return {
    config: ({ input }) => structuredClone(need(input.uuid)),
    configure: ({ input }) => {
      const cur = need(input.uuid);
      if (!/^(https:\/\/|ssh:\/\/|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:)/.test(input.repoUrl) || input.repoUrl.includes("::")) throw new TRPCError({ code: "BAD_REQUEST", message: "INVALID_REPO_URL" });
      if (input.authType === "token" && !cur.tokenSet && !input.token) throw new TRPCError({ code: "BAD_REQUEST", message: "TOKEN_REQUIRED" });
      const host = ssh(input.repoUrl) ? (/@([^:/]+)/.exec(input.repoUrl)?.[1] ?? "git.example.test") : null;
      const builtin = host && ["github.com", "gitlab.com", "bitbucket.org"].includes(host);
      const next: s.DeployConfig = {
        ...cur,
        configured: true,
        repoUrl: input.repoUrl,
        branch: input.branch ?? "main",
        authType: input.authType,
        tokenSet: input.authType === "token" && (input.token === undefined ? cur.tokenSet : input.token !== null),
        tokenUsername: input.tokenUsername ?? null,
        targetDir: input.targetDir ?? cur.defaultTargetDir,
        sourceDir: input.sourceDir ?? "/",
        buildCommand: input.buildCommand ?? null,
        buildImage: input.buildImage ?? "site",
        sharedPaths: input.sharedPaths ?? [],
        restartAfter: input.restartAfter ?? false,
        autoDeploy: input.autoDeploy ?? true,
        sshPublicKey: input.authType === "ssh" ? (cur.sshPublicKey ?? PUBLIC_KEY) : cur.sshPublicKey,
        sshHost: host && builtin ? { host, port: 22, trust: "builtin", keys: [{ type: "ssh-ed25519", fingerprint: "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU" }] } : cur.sshHost?.host === host ? cur.sshHost : null,
        webhookUrl: cur.webhookUrl ?? `https://panel.test/api/deploy/webhook/mock-${input.uuid.slice(0, 8)}`,
        webhookSecret: cur.webhookSecret ?? "mock-webhook-secret-0123456789",
      };
      configs.set(input.uuid, next);
      return structuredClone(next);
    },
    disconnect: ({ input }) => (need(input.uuid), configs.delete(input.uuid), ok),
    generateKey: ({ input }) => {
      const cur = need(input.uuid);
      const next = { ...cur, sshPublicKey: PUBLIC_KEY.replace("Mock", "Mok" + Math.floor(Math.random() * 9)) };
      configs.set(input.uuid, next);
      return structuredClone(next);
    },
    scanHostKey: ({ input }) => {
      need(input.uuid);
      const host = /@([^:/]+)/.exec(input.repoUrl)?.[1] ?? "git.example.test";
      return { host, port: 22, keys: [{ type: "ssh-ed25519", fingerprint: "SHA256:mOcKfInGeRpRiNt0123456789abcdefghijklmnopq" }], builtin: ["github.com", "gitlab.com", "bitbucket.org"].includes(host) };
    },
    trustHostKey: ({ input }) => {
      const cur = need(input.uuid);
      const host = /@([^:/]+)/.exec(input.repoUrl)?.[1] ?? "git.example.test";
      const next: s.DeployConfig = { ...cur, sshHost: { host, port: 22, trust: "confirmed", keys: input.fingerprints.map((f) => ({ type: "ssh-ed25519", fingerprint: f })) } };
      configs.set(input.uuid, next);
      return structuredClone(next);
    },
    rotateWebhookSecret: ({ input }) => {
      const cur = need(input.uuid);
      const next = { ...cur, webhookSecret: `mock-webhook-secret-${Math.random().toString(36).slice(2, 12)}` };
      configs.set(input.uuid, next);
      return structuredClone(next);
    },
    start: ({ input, ctx }) => {
      const cfg = need(input.uuid);
      if (!cfg.configured) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NOT_CONFIGURED" });
      if (history.some((h) => h.serverUuid === input.uuid && advance(h).status === "running")) throw new TRPCError({ code: "CONFLICT", message: "DEPLOY_RUNNING" });
      const x: s.Deploy & { log: string[] } = {
        id: d.nextId(),
        serverUuid: input.uuid,
        status: "running",
        trigger: "manual",
        branch: cfg.branch,
        commitSha: null,
        commitAuthor: null,
        commitMessage: null,
        commitDate: null,
        triggeredBy: ctx.session ? d.userName(ctx.session.userId) : null,
        error: null,
        startedAt: new Date(),
        finishedAt: null,
        durationMs: null,
        log: [LOG[0]!],
      };
      history.unshift(x);
      return strip(x);
    },
    cancel: ({ input }) => {
      const x = find(input.id);
      if (x.status !== "running") throw new TRPCError({ code: "CONFLICT", message: "DEPLOY_NOT_RUNNING" });
      Object.assign(x, { status: "cancelled", error: "cancelled", finishedAt: new Date(), durationMs: Date.now() - x.startedAt.getTime(), log: [...x.log, "Deploy cancelled; the previous version is still live."] });
      return ok;
    },
    list: ({ input }) => {
      need(input.uuid);
      const items = history.filter((h) => h.serverUuid === input.uuid).map((h) => strip(advance(h)));
      return { items: items.slice(0, input.limit), nextCursor: null };
    },
    get: ({ input }) => {
      const x = find(input.id);
      const running = x.status === "running";
      const phase = running ? (x.log.length < 5 ? "fetching" : x.log.length < 12 ? "building" : "publishing") : null;
      return { ...strip(x), log: [...x.log], phase, cancellable: running && phase !== "publishing" };
    },
  };
}
