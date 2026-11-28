import { describe, expect, it } from "vitest";
import { createMock, mockSession } from "./mock";
import { buildRouter, createCallerFactory, type Ctx } from "./trpc-builder";

const ctx = (role: "admin" | "user"): Ctx => ({ session: mockSession(role), ip: "127.0.0.1", userAgent: "test", resHeaders: new Headers() });

describe("mail-mock via de echte router (output-validatie)", () => {
  const caller = createCallerFactory(buildRouter(createMock()))(ctx("admin"));

  it("voorbeelddata: 3 domeinen, ~15 mailboxen, catch-all, rode checks, wachtrij", async () => {
    const st = await caller.mail.status();
    expect(st.containers.length).toBeGreaterThanOrEqual(6);
    const domains = await caller.mail.domains.list();
    expect(new Set(domains.map((d) => d.dnsStatus))).toEqual(new Set(["ok", "pending", "error"]));
    let boxes = 0;
    for (const d of domains) {
      await caller.mail.domains.get({ id: d.id });
      await caller.mail.domains.dnsRecords({ id: d.id });
      boxes += (await caller.mail.mailboxes.list({ domainId: d.id })).length;
      await caller.mail.aliases.list({ domainId: d.id });
    }
    expect(boxes).toBe(15);
    expect((await caller.mail.aliases.list({ domainId: 1 })).some((a) => a.catchAll)).toBe(true);
    expect((await caller.mail.checks.last())!.checks.filter((c) => !c.ok).length).toBeGreaterThan(1);
    expect(await caller.mail.queue.list()).toHaveLength(4);
  });

  it("mutaties", async () => {
    await expect(caller.mail.enable()).rejects.toMatchObject({ message: "MAIL_CHECKS_FAILED" });
    await caller.mail.disable();
    const d = await caller.mail.domains.create({ domain: "nieuw.panel.test", firstMailbox: { localPart: "info", password: "123456789012" } });
    expect(d.aliasCount).toBe(2);
    await caller.mail.domains.update({ id: d.id, maxQuotaMb: 2048 });
    await caller.mail.domains.checkDns({ id: d.id });
    await caller.mail.domains.rotateDkim({ id: d.id });
    await expect(caller.mail.domains.applyDns({ id: d.id })).rejects.toMatchObject({ message: "MAIL_NO_DNS_PROVIDER" });
    await caller.mail.domains.applyDns({ id: 1 });
    const m = await caller.mail.mailboxes.create({ domainId: d.id, localPart: "kees", password: "123456789012", quotaMb: 512 });
    await expect(caller.mail.mailboxes.create({ domainId: d.id, localPart: "groot", password: "123456789012", quotaMb: 1024 })).rejects.toMatchObject({ message: "MAIL_DOMAIN_QUOTA" });
    await caller.mail.mailboxes.update({ id: m.id, active: false });
    await caller.mail.mailboxes.setPassword({ id: m.id, password: "abcdefghijkl" });
    const a = await caller.mail.aliases.create({ domainId: d.id, localPart: null, goto: ["info@nieuw.panel.test"] });
    expect(a.address).toBe("@nieuw.panel.test");
    await caller.mail.aliases.update({ id: a.id, active: false });
    await caller.mail.aliases.delete({ id: a.id });
    await caller.mail.mailboxes.delete({ id: m.id });
    await caller.mail.queue.delete({ queueId: "4F2A31C0B1" });
    await caller.mail.queue.flush();
    await caller.mail.checks.run();
    await caller.mail.domains.delete({ id: d.id });
  });

  it("niet-admin: FORBIDDEN", async () => {
    const user = createCallerFactory(buildRouter(createMock()))(ctx("user"));
    await expect(user.mail.domains.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
