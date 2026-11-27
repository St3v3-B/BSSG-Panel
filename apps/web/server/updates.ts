/**
 * Panel-updates (Admin > Settings > Updates): status van de lokale daemon (git), CI-status per commit
 * van GitHub (publieke API, zonder token, gecachet) en het starten van deploy/upgrade.sh via de daemon.
 */
import type { AvailableUpdate, CiStatus, PanelCommit, UpdatesStatus, UpgradeRun } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { logActivity } from "./activity";
import { DaemonHttpError, call, daemonFor, toTrpcError } from "./daemon";
import { getDb, schema } from "./db";

/** Alleen tests: vervangt de GitHub-aanroepen. */
export const githubTransport = { fetch: (...a: Parameters<typeof fetch>) => fetch(...a) };

const REF_RE = /^(origin\/main|[0-9a-f]{7,40})$/;
export const validRef = (r: string) => REF_RE.test(r);

// ---------- instelling ----------

export async function updatesEnabled(): Promise<boolean> {
  const [row] = await getDb().select().from(schema.settings).where(eq(schema.settings.key, "updates_enabled"));
  return row?.value !== false; // standaard aan
}

export async function setUpdatesEnabled(enabled: boolean): Promise<void> {
  await getDb().insert(schema.settings).values({ key: "updates_enabled", value: enabled }).onConflictDoUpdate({ target: schema.settings.key, set: { value: enabled } });
}

// ---------- GitHub ----------

/** `owner/naam` uit PANEL_GITHUB_REPO, anders uit de git-remote (https of ssh). */
export function githubRepo(origin: string | null | undefined): string | null {
  const env = process.env.PANEL_GITHUB_REPO?.trim();
  if (env) return /^[\w.-]+\/[\w.-]+$/.test(env) ? env : null;
  const m = /(?:github\.com|@github[\w.-]*)[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(origin ?? "");
  return m ? `${m[1]}/${m[2]}` : null;
}

const ciCache = new Map<string, { status: CiStatus; at: number }>();
const CI_FINAL_TTL = 60 * 60_000;
const CI_SOFT_TTL = 60_000;
export const resetCiCache = () => ciCache.clear();

interface CheckRun { status: string; conclusion: string | null }

export function summarizeRuns(runs: CheckRun[]): CiStatus {
  if (runs.length === 0) return "none";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  if (runs.some((r) => ["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"].includes(r.conclusion ?? ""))) return "failure";
  return "success";
}

export async function ciFor(repo: string | null, sha: string): Promise<CiStatus> {
  if (!repo || !/^[0-9a-f]{7,40}$/.test(sha)) return "unknown";
  const key = `${repo}@${sha}`;
  const hit = ciCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < (hit.status === "success" || hit.status === "failure" ? CI_FINAL_TTL : CI_SOFT_TTL)) return hit.status;
  let status: CiStatus = "unknown";
  try {
    const res = await githubTransport.fetch(`https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=100`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "panel-updates", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) status = summarizeRuns(((await res.json()) as { check_runs?: CheckRun[] }).check_runs ?? []);
  } catch {
    /* unknown */
  }
  ciCache.set(key, { status, at: now });
  return status;
}

// ---------- versie ----------

export function runningVersion(): PanelCommit | null {
  const sha = process.env.PANEL_COMMIT?.trim();
  if (!sha || sha === "unknown") return null;
  return { sha, date: process.env.PANEL_COMMIT_DATE?.trim() || null, message: process.env.PANEL_COMMIT_MESSAGE?.trim() ?? "" };
}

async function localNode() {
  const [n] = await getDb().select().from(schema.nodes).where(eq(schema.nodes.isLocal, true));
  return n ?? null;
}

const STATES = ["idle", "running", "success", "failed", "rolled_back"] as const;
function runOf(u: unknown): UpgradeRun | null {
  if (!u || typeof u !== "object") return null;
  const r = u as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === "string" && r[k] ? (r[k] as string) : null);
  const state = STATES.find((s) => s === r.state);
  if (!state) return null;
  return { state, from: str("from") ?? "", to: str("to") ?? "", step: str("step") ?? "", started: str("started"), finished: str("finished"), error: str("error") };
}

const msg = (e: unknown) => (e instanceof TRPCError ? e.message : e instanceof Error ? e.message : String(e));

export async function updatesStatus(refresh: boolean): Promise<UpdatesStatus> {
  const enabled = await updatesEnabled();
  const base: UpdatesStatus = {
    enabled,
    current: runningVersion() ?? { sha: "unknown", date: null, message: "" },
    daemonVersion: null,
    daemonCommit: null,
    available: [],
    upgrade: null,
    logTail: "",
    canUpgrade: false,
    error: null,
    githubRepo: githubRepo(null),
  };
  const node = await localNode();
  if (!node) return { ...base, error: "NO_LOCAL_NODE" };
  let st;
  try {
    st = await call(() => daemonFor(node).getPanelUpgradeStatus(refresh));
  } catch (e) {
    const m = msg(e);
    return { ...base, error: /NOT_LOCAL/i.test(m) ? "NOT_LOCAL" : m };
  }
  const repo = githubRepo(st.origin);
  const commits = st.commits ?? [];
  const cis = await Promise.all(commits.slice(0, 20).map((c) => ciFor(repo, c.sha)));
  const available: AvailableUpdate[] = commits.map((c, i) => ({ sha: c.sha, date: c.date ?? null, message: c.message, author: c.author ?? null, ci: cis[i] ?? "unknown" }));
  const upgrade = runOf(st.upgrade);
  void logFinished(upgrade);
  return {
    ...base,
    current: runningVersion() ?? { sha: st.current.sha, date: st.current.date ?? null, message: st.current.message },
    daemonVersion: st.daemon_version || null,
    daemonCommit: st.daemon_commit || null,
    available,
    upgrade,
    logTail: st.log_tail ?? "",
    canUpgrade: true,
    error: st.fetch_error ?? null,
    githubRepo: repo,
  };
}

/** Eén activiteitenlog-regel per afgeronde upgrade (de pagina pollt; dedupe via een instelling). */
async function logFinished(u: UpgradeRun | null): Promise<void> {
  if (!u || u.state === "running" || u.state === "idle" || !u.started) return;
  const id = `${u.started}/${u.state}`;
  const [row] = await getDb().select().from(schema.settings).where(eq(schema.settings.key, "updates_last_logged"));
  if (row?.value === id) return;
  await getDb().insert(schema.settings).values({ key: "updates_last_logged", value: id }).onConflictDoUpdate({ target: schema.settings.key, set: { value: id } });
  await logActivity({ action: `admin.updates.${u.state}`, metadata: { from: u.from, to: u.to, error: u.error } });
}

const precondition = (m: string) => new TRPCError({ code: "PRECONDITION_FAILED", message: m });

export async function startUpgrade(input: { ref?: string; onlyIfCiGreen: boolean }, who: { userId: number | null; ip: string | null }): Promise<{ unit: string }> {
  if (!(await updatesEnabled())) throw precondition("UPDATES_DISABLED");
  const ref = input.ref?.trim() || "origin/main";
  if (!validRef(ref)) throw new TRPCError({ code: "BAD_REQUEST", message: "INVALID_REF" });
  const node = await localNode();
  if (!node) throw new TRPCError({ code: "NOT_FOUND", message: "NO_LOCAL_NODE" });
  const daemon = daemonFor(node);
  if (input.onlyIfCiGreen) {
    const st = await call(() => daemon.getPanelUpgradeStatus(false));
    const repo = githubRepo(st.origin);
    const sha = ref === "origin/main" ? st.commits?.[0]?.sha : ref;
    if (sha) {
      const ci = await ciFor(repo, sha);
      if (ci !== "success") throw precondition("CI_NOT_GREEN");
    }
  }
  let started;
  try {
    started = await daemon.startPanelUpgrade(ref);
  } catch (e) {
    if (e instanceof DaemonHttpError && e.status === 409) throw precondition("UPGRADE_RUNNING");
    throw toTrpcError(e);
  }
  await logActivity({ action: "admin.updates.start", userId: who.userId, ip: who.ip, metadata: { ref, onlyIfCiGreen: input.onlyIfCiGreen, unit: started.unit } });
  return { unit: started.unit };
}
