/**
 * Eenvoudige rate limiter (vaste vensters) in Redis (REDIS_URL). Is Redis niet bereikbaar,
 * dan telt hij in het geheugen van dit proces, zodat een Redis-storing logins niet blokkeert.
 */
import { Redis } from "ioredis";
import { getEnv } from "../env";

export interface Limiter {
  /** Telt een poging; geeft het aantal in het huidige venster. */
  hit(key: string, windowSeconds: number): Promise<number>;
  get(key: string): Promise<number>;
  reset(key: string): Promise<void>;
}

class MemoryLimiter implements Limiter {
  private m = new Map<string, { n: number; until: number }>();
  private cur(key: string) {
    const e = this.m.get(key);
    if (e && e.until > Date.now()) return e;
    this.m.delete(key);
    return null;
  }
  async hit(key: string, windowSeconds: number) {
    const e = this.cur(key) ?? { n: 0, until: Date.now() + windowSeconds * 1000 };
    e.n++;
    this.m.set(key, e);
    return e.n;
  }
  async get(key: string) {
    return this.cur(key)?.n ?? 0;
  }
  async reset(key: string) {
    this.m.delete(key);
  }
}

class RedisLimiter implements Limiter {
  constructor(private r: Redis, private fallback: Limiter) {}
  private async safe<T>(fn: () => Promise<T>, fb: () => Promise<T>): Promise<T> {
    if (this.r.status !== "ready") {
      this.r.connect().catch(() => {});
      return fb();
    }
    try {
      return await fn();
    } catch {
      return fb();
    }
  }
  hit(key: string, windowSeconds: number) {
    return this.safe(
      async () => {
        const [[, n]] = (await this.r.multi().incr(key).expire(key, windowSeconds, "NX").exec()) as [[unknown, number]];
        return n;
      },
      () => this.fallback.hit(key, windowSeconds),
    );
  }
  get(key: string) {
    return this.safe(async () => Number((await this.r.get(key)) ?? 0), () => this.fallback.get(key));
  }
  reset(key: string) {
    return this.safe(async () => void (await this.r.del(key)), () => this.fallback.reset(key));
  }
}

const g = globalThis as unknown as { __panelLimiter?: Limiter; __panelRedis?: Redis };

export function getLimiter(): Limiter {
  if (g.__panelLimiter) return g.__panelLimiter;
  const memory = new MemoryLimiter();
  try {
    const r = new Redis(getEnv().REDIS_URL, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, connectTimeout: 1000, retryStrategy: () => null });
    r.on("error", () => {});
    r.connect().catch(() => {});
    g.__panelRedis = r;
    g.__panelLimiter = new RedisLimiter(r, memory);
  } catch {
    g.__panelLimiter = memory;
  }
  return g.__panelLimiter;
}

/** Alleen voor tests. */
export async function resetLimiter(): Promise<void> {
  g.__panelRedis?.disconnect();
  g.__panelRedis = undefined;
  g.__panelLimiter = undefined;
}
