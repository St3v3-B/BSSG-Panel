import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyEnv, baseEnv } from "./test/harness";
import { startRedis, type TestContainer } from "./test/docker";
import { getLimiter, resetLimiter } from "./lib/ratelimit";

let redis: TestContainer;

beforeAll(async () => {
  redis = await startRedis();
  applyEnv(baseEnv({ REDIS_URL: `redis://127.0.0.1:${redis.port}` }));
  await resetLimiter();
}, 120_000);

afterAll(async () => {
  await resetLimiter();
  await redis?.stop();
});

describe("rate limiter", () => {
  it("telt in Redis (gedeeld tussen instanties) en reset", async () => {
    const l = getLimiter();
    const key = `t:${Date.now()}`;
    expect(await l.hit(key, 60)).toBe(1);
    expect(await l.hit(key, 60)).toBe(2);
    await resetLimiter(); // nieuwe verbinding: zelfde teller, dus echt in Redis
    const l2 = getLimiter();
    expect(await l2.get(key)).toBe(2);
    await l2.reset(key);
    expect(await l2.get(key)).toBe(0);
  });

  it("valt terug op geheugen als Redis wegvalt", async () => {
    await redis.stop();
    const l = getLimiter();
    expect(await l.hit("weg", 60)).toBe(1);
    expect(await l.hit("weg", 60)).toBe(2);
  });
});
