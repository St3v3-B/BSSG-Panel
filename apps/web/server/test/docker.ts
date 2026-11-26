/** Wegwerpcontainers (Redis, MariaDB) voor tests, met dezelfde labels als docker-pg.ts. */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { reapStale } from "./docker-pg";

const run = promisify(execFile);
export const docker = async (...args: string[]) => (await run("docker", args, { timeout: 180_000 })).stdout.trim();

export interface TestContainer {
  id: string;
  port: number;
  stop: () => Promise<void>;
}

export async function startContainer(o: { image: string; port: number; env?: Record<string, string>; args?: string[]; ready: (id: string) => Promise<void>; timeoutMs?: number }): Promise<TestContainer> {
  await reapStale().catch(() => {});
  const instance = `panel-api-${process.pid}-${randomBytes(3).toString("hex")}`;
  const id = await docker(
    "run", "-d", "--rm",
    "--label", "panel.test=true",
    "--label", `panel.instance=${instance}`,
    "--label", "panel.agent=panel-api",
    "--label", `panel.api.pid=${process.pid}`,
    "--name", instance,
    ...Object.entries(o.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "-p", `127.0.0.1::${o.port}`,
    o.image, ...(o.args ?? []),
  );
  const stop = async () => void (await docker("rm", "-f", id).catch(() => {}));
  try {
    const port = Number((await docker("port", id, `${o.port}/tcp`)).split("\n")[0]!.split(":").pop());
    const deadline = Date.now() + (o.timeoutMs ?? 90_000);
    for (;;) {
      try {
        await o.ready(id);
        break;
      } catch (e) {
        if (Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return { id, port, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

export const startRedis = () =>
  startContainer({ image: "redis:7-alpine", port: 6379, args: ["--save", ""], ready: async (id) => void (await docker("exec", id, "redis-cli", "ping")) });

export const startMariadb = (rootPassword: string) =>
  startContainer({
    image: "mariadb:11",
    port: 3306,
    env: { MARIADB_ROOT_PASSWORD: rootPassword },
    args: ["--innodb-buffer-pool-size=32M", "--performance-schema=OFF"],
    timeoutMs: 120_000,
    ready: async (id) => void (await docker("exec", id, "mariadb", "-h127.0.0.1", "-uroot", `-p${rootPassword}`, "-e", "select 1")),
  });
