/** Wegwerp-Redis in Docker voor tests (labels panel.test=true + eigen panel.instance; ruimt alleen zichzelf op). */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { AGENT } from "./docker-pg";

const run = promisify(execFile);
const docker = async (...args: string[]) => (await run("docker", args, { timeout: 120_000 })).stdout.trim();

export async function startRedis(): Promise<{ url: string; stop: () => Promise<void> }> {
  const instance = `${AGENT}-redis-${process.pid}-${randomBytes(3).toString("hex")}`;
  const id = await docker("run", "-d", "--rm", "--label", "panel.test=true", "--label", `panel.instance=${instance}`, "--label", `panel.agent=${AGENT}`, "--label", `panel.api.pid=${process.pid}`, "--name", instance, "-p", "127.0.0.1::6379", "redis:7-alpine");
  const stop = async () => void (await docker("rm", "-f", id).catch(() => {}));
  try {
    const port = (await docker("port", id, "6379/tcp")).split("\n")[0]!.split(":").pop();
    for (let i = 0; i < 50; i++) {
      try {
        if ((await docker("exec", id, "redis-cli", "ping")) === "PONG") return { url: `redis://127.0.0.1:${port}`, stop };
      } catch {
        /* nog niet klaar */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("redis does not start");
  } catch (e) {
    await stop();
    throw e;
  }
}
