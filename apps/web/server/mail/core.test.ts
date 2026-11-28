import { createPublicKey, createSign, createVerify } from "node:crypto";
import { verify } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";
import type { DnsLookup } from "../lib/dns";
import { fromDaemon, newlyFailed } from "./checks";
import { buildRecords, dkimRecordValue, dnsStatusOf, generateDkimKey, hashMailPassword, judge, lookupRecords, nextSelector, toStored, verifyMailPassword, withStoredStatus, type RecordContext } from "./core";

describe("mailwachtwoorden", () => {
  it("Dovecot-formaat {ARGON2ID} met m=65536,t=3,p=1, verifieerbaar met @node-rs/argon2", async () => {
    const h = await hashMailPassword("correct horse battery");
    expect(h).toMatch(/^\{ARGON2ID\}\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(await verify(h.slice("{ARGON2ID}".length), "correct horse battery")).toBe(true);
    expect(await verifyMailPassword(h, "correct horse battery")).toBe(true);
    expect(await verifyMailPassword(h, "wrong password!!")).toBe(false);
    expect(await verifyMailPassword(h.slice(10), "correct horse battery")).toBe(false);
  });
  it("weigert korter dan 12 tekens", async () => {
    await expect(hashMailPassword("kort")).rejects.toThrow();
  });
});

describe("DKIM", () => {
  it("RSA-2048: p= is base64 DER (SPKI) die bij de private key hoort", () => {
    const k = generateDkimKey();
    expect(k.privateKeyPem).toContain("BEGIN RSA PRIVATE KEY");
    const pub = createPublicKey({ key: Buffer.from(k.publicKey, "base64"), format: "der", type: "spki" });
    expect(pub.asymmetricKeyDetails?.modulusLength).toBe(2048);
    const sig = createSign("sha256").update("x").sign(k.privateKeyPem);
    expect(createVerify("sha256").update("x").verify(pub, sig)).toBe(true);
    expect(dkimRecordValue(k.publicKey)).toBe(`v=DKIM1; k=rsa; p=${k.publicKey}`);
  });
  it("selector bij roteren", () => {
    const d = new Date("2026-11-28T10:00:00Z");
    expect(nextSelector(["dkim"], d)).toBe("dkim20261128");
    expect(nextSelector(["dkim", "dkim20261128"], d)).toBe("dkim20261128b");
  });
});

const ctx: RecordContext = { domain: "panel.test", mailHostname: "mail.panel.test", ipv4: "203.0.113.10", ipv6: "2001:db8::10", dkim: { selector: "dkim", publicKey: "QUJD" } };

describe("DNS-records", () => {
  it("bouwt A/AAAA (info), MX, SPF, DKIM, DMARC en PTR (advies)", () => {
    const r = buildRecords(ctx);
    expect(r.map((x) => [x.id, x.type, x.name, x.value, x.required])).toEqual([
      ["a", "A", "mail.panel.test", "203.0.113.10", false],
      ["aaaa", "AAAA", "mail.panel.test", "2001:db8::10", false],
      ["mx", "MX", "panel.test", "mail.panel.test", true],
      ["spf", "TXT", "panel.test", "v=spf1 mx -all", true],
      ["dkim", "TXT", "dkim._domainkey.panel.test", "v=DKIM1; k=rsa; p=QUJD", true],
      ["dmarc", "TXT", "_dmarc.panel.test", "v=DMARC1; p=none; rua=mailto:dmarc@panel.test", true],
      ["ptr", "PTR", "203.0.113.10", "mail.panel.test", false],
    ]);
    expect(r.find((x) => x.id === "mx")!.priority).toBe(10);
    expect(r.find((x) => x.id === "ptr")!.where).toBe("hosting");
    // Zonder IP geen A/AAAA/PTR.
    expect(buildRecords({ ...ctx, ipv4: null, ipv6: null }).map((x) => x.id)).toEqual(["mx", "spf", "dkim", "dmarc"]);
  });

  it("beoordeelt SPF, DKIM, DMARC en MX", () => {
    const rec = (id: string) => buildRecords(ctx).find((x) => x.id === id)!;
    expect(judge(rec("spf"), ["v=spf1 mx -all", "google-site-verification=x"], ctx).status).toBe("ok");
    expect(judge(rec("spf"), ["v=spf1 ip4:203.0.113.10 ~all"], ctx).status).toBe("ok");
    expect(judge(rec("spf"), ["v=spf1 include:_spf.example.com -all"], ctx).status).toBe("wrong");
    expect(judge(rec("spf"), ["v=spf1 mx -all", "v=spf1 a -all"], ctx).status).toBe("wrong");
    expect(judge(rec("spf"), ["other"], ctx).status).toBe("missing");
    expect(judge(rec("dkim"), ["v=DKIM1; k=rsa; p=QU JD"], ctx).status).toBe("ok");
    expect(judge(rec("dkim"), ["v=DKIM1; k=rsa; p=QUJE"], ctx).status).toBe("wrong");
    expect(judge(rec("dkim"), [], ctx).status).toBe("missing");
    expect(judge(rec("dmarc"), ["v=DMARC1; p=quarantine"], ctx).status).toBe("ok");
    expect(judge(rec("dmarc"), ["v=DMARC1; p=none", "v=DMARC1; p=reject"], ctx).status).toBe("wrong");
    expect(judge(rec("mx"), ["20 mail.panel.test", "10 backup.example.com"], ctx).status).toBe("ok");
    expect(judge(rec("mx"), ["10 mx.old.example"], ctx).status).toBe("wrong");
    expect(judge(rec("mx"), [], ctx).status).toBe("missing");
  });

  it("dns_status met een nep-resolver", async () => {
    const zone: Record<string, Partial<Record<"a" | "aaaa" | "mx" | "txt" | "ptr", string[]>>> = {
      "mail.panel.test": { a: ["203.0.113.10"] },
      "panel.test": { mx: ["10 mail.panel.test"], txt: ["v=spf1 mx -all"] },
      "dkim._domainkey.panel.test": { txt: ["v=DKIM1; k=rsa; p=QUJD"] },
    };
    const l: DnsLookup = {
      a: async (n) => zone[n]?.a ?? [],
      aaaa: async (n) => zone[n]?.aaaa ?? [],
      cname: async () => [],
      ns: async () => [],
      srv: async () => [],
      mx: async (n) => zone[n]?.mx ?? [],
      txt: async (n) => zone[n]?.txt ?? [],
      ptr: async (n) => zone[n]?.ptr ?? [],
    };
    let recs = await lookupRecords(buildRecords(ctx), ctx, l);
    expect(Object.fromEntries(recs.map((r) => [r.id, r.status]))).toEqual({ a: "ok", aaaa: "missing", mx: "ok", spf: "ok", dkim: "ok", dmarc: "missing", ptr: "missing" });
    // DMARC ontbreekt (verplicht) → in afwachting; AAAA en PTR tellen niet mee.
    expect(dnsStatusOf(recs)).toBe("pending");
    zone["_dmarc.panel.test"] = { txt: ["v=DMARC1; p=none"] };
    recs = await lookupRecords(buildRecords(ctx), ctx, l);
    expect(dnsStatusOf(recs)).toBe("ok");
    zone["panel.test"]!.mx = ["10 mx.elders.example"];
    recs = await lookupRecords(buildRecords(ctx), ctx, l);
    expect(dnsStatusOf(recs)).toBe("error");

    // Bewaarde status; na een andere DKIM-sleutel is dat record weer "unchecked".
    const stored = toStored(recs);
    expect(withStoredStatus(buildRecords(ctx), stored).find((r) => r.id === "mx")!.status).toBe("wrong");
    const rotated = withStoredStatus(buildRecords({ ...ctx, dkim: { selector: "dkim2", publicKey: "WFla" } }), stored);
    expect(rotated.find((r) => r.id === "dkim")!.status).toBe("unchecked");
    expect(rotated.find((r) => r.id === "spf")!.status).toBe("ok");
  });
});

describe("systeemcheck", () => {
  it("vertaalt het daemonrapport en laat onbekende ids weg", () => {
    const r = fromDaemon({
      checked_at: "2026-11-28T10:00:00Z",
      checks: [
        { id: "ptr", ok: false, required: true, detail: "x", hint: "set PTR" },
        { id: "clock", ok: false, required: false, detail: "1.5 s" },
        { id: "something_new", ok: true, required: true, detail: "" },
      ],
    });
    expect(r.checks.map((c) => c.id)).toEqual(["ptr", "clock"]);
    expect(r.checks[1]!.hint).toBeNull();
    expect(r.ok).toBe(false);
    expect(fromDaemon({ checked_at: "x", checks: [{ id: "clock", ok: false, required: false, detail: "" }] }).ok).toBe(true);
  });
  it("groen → rood alleen voor verplichte checks", () => {
    const mk = (ptr: boolean, clock: boolean) => fromDaemon({ checked_at: "2026-11-28T10:00:00Z", checks: [{ id: "ptr", ok: ptr, required: true, detail: "" }, { id: "clock", ok: clock, required: false, detail: "" }] });
    expect(newlyFailed(null, mk(false, false))).toEqual([]);
    expect(newlyFailed(mk(true, true), mk(false, false)).map((c) => c.id)).toEqual(["ptr"]);
    expect(newlyFailed(mk(false, true), mk(false, true))).toEqual([]);
  });
});
