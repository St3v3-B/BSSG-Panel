/**
 * Wegwerp-Postgres in Docker voor tests. Labels: panel.test=true, panel.instance=panel-api-<pid>-<rand>
 * en panel.agent=panel-api. Ruimt alleen eigen containers op (beide labels + eigen prefix).
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);
/** Label/name prefix of this test run; agents set TEST_AGENT to keep their own containers apart. */
export const AGENT = process.env.TEST_AGENT ?? "panel-api";
const docker = async (...args: string[]) => (await run("docker", args, { timeout: 120_000 })).stdout.trim();

export async function reapStale(): Promise<void> {
  const out = await docker("ps", "-a", "--filter", "label=panel.test=true", "--filter", `label=panel.agent=${AGENT}`, "--format", '{{.ID}} {{.Label "panel.instance"}} {{.Label "panel.api.pid"}}');
  for (const line of out.split("\n").filter(Boolean)) {
    const [id, instance, pid] = line.split(" ");
    if (!id || !instance?.startsWith(`${AGENT}-`) || !pid) continue;
    let alive = true;
    try {
      process.kill(Number(pid), 0);
    } catch {
      alive = false;
    }
    if (!alive) await docker("rm", "-f", id).catch(() => {});
  }
}

export interface TestPg {
  url: string;
  instance: string;
  stop: () => Promise<void>;
}

export async function startPostgres(): Promise<TestPg> {
  await reapStale().catch(() => {});
  const instance = `${AGENT}-${process.pid}-${randomBytes(3).toString("hex")}`;
  const id = await docker(
    "run", "-d", "--rm",
    "--label", "panel.test=true",
    "--label", `panel.instance=${instance}`,
    "--label", `panel.agent=${AGENT}`,
    "--label", `panel.api.pid=${process.pid}`,
    "--name", instance,
    "--tmpfs", "/var/lib/postgresql/data",
    "-e", "POSTGRES_PASSWORD=test", "-e", "POSTGRES_DB=panel",
    "-p", "127.0.0.1::5432",
    "postgres:16-alpine", "-c", "fsync=off", "-c", "full_page_writes=off", "-c", "synchronous_commit=off",
  );
  const stop = async () => {
    await docker("rm", "-f", id).catch(() => {});
  };
  try {
    const port = (await docker("port", id, "5432/tcp")).split("\n")[0]!.split(":").pop();
    const deadline = Date.now() + 60_000;
    // pg_isready kan te vroeg ja zeggen tijdens de init-herstart: wacht op twee keer select 1 met pauze.
    let okCount = 0;
    while (Date.now() < deadline && okCount < 2) {
      try {
        await docker("exec", id, "psql", "-U", "postgres", "-d", "panel", "-h", "127.0.0.1", "-c", "select 1");
        okCount++;
        if (okCount < 2) await new Promise((r) => setTimeout(r, 700));
      } catch {
        okCount = 0;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (okCount < 2) throw new Error("postgres does not start");
    return { url: `postgres://postgres:test@127.0.0.1:${port}/panel`, instance, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}
