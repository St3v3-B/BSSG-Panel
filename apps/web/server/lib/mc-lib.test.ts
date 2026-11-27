import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildZip } from "../test/zip-build";
import { fetchBytes } from "./http";
import { MrpackError, planPack, safeRelPath } from "./mrpack";
import { readZip } from "./zip";

afterEach(() => vi.unstubAllGlobals());

describe("safeRelPath", () => {
  it("laat normale paden door en weigert ontsnappende", () => {
    expect(safeRelPath("mods/a.jar")).toBe("mods/a.jar");
    expect(safeRelPath("config/sub/x.toml")).toBe("config/sub/x.toml");
    for (const p of ["", "/abs", "../x", "a/../b", "a/./b", "a//b", "a\\b", "C:\\x", "d:x", "a\u0000b", "a/..", "x".repeat(300)]) expect(() => safeRelPath(p), p).toThrow(MrpackError);
  });
});

describe("planPack", () => {
  const idx = (o: object = {}) => JSON.stringify({ formatVersion: 1, game: "minecraft", versionId: "1", name: "p", dependencies: { minecraft: "1.21", "fabric-loader": "0.16.1" }, files: [], ...o });
  it("leest afhankelijkheden en filtert client-only", () => {
    const f = { path: "mods/a.jar", hashes: { sha512: "a".repeat(128) }, downloads: ["https://cdn.modrinth.com/x"], fileSize: 1 };
    const plan = planPack(buildZip({ "modrinth.index.json": idx({ files: [f, { ...f, path: "mods/b.jar", env: { server: "unsupported" } }] }), "overrides/x.txt": "1" }));
    expect(plan).toMatchObject({ minecraftVersion: "1.21", loaderVersion: "0.16.1", skipped: 1 });
    expect(plan.files.map((x) => x.path)).toEqual(["mods/a.jar"]);
    expect(plan.overrides.map((o) => o.path)).toEqual(["x.txt"]);
  });
  it("controleert ook de paden van overgeslagen bestanden", () => {
    const f = { path: "../x", hashes: { sha512: "a".repeat(128) }, env: { server: "unsupported" }, downloads: ["https://cdn.modrinth.com/x"], fileSize: 1 };
    expect(() => planPack(buildZip({ "modrinth.index.json": idx({ files: [f] }) }))).toThrow(/PATH_ESCAPES/);
  });
  it("weigert ontbrekende index, kapotte index en vreemde ingangsnamen", () => {
    expect(() => planPack(buildZip({ "x.txt": "1" }))).toThrow(/BAD_MODPACK/);
    expect(() => planPack(buildZip({ "modrinth.index.json": "{" }))).toThrow(/BAD_MODPACK/);
    expect(() => planPack(buildZip({ "modrinth.index.json": idx(), "../../evil": "1" }))).toThrow(/PATH_ESCAPES/);
  });
});

describe("readZip", () => {
  const limits = { maxEntries: 10, maxEntryBytes: 1000, maxTotalBytes: 1500 };
  it("begrenst aantal, grootte en totaal; weigert versleuteld", () => {
    expect(() => readZip(buildZip(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}`, "x"]))), limits)).toThrow(/too many/);
    expect(() => readZip(buildZip({ a: "x".repeat(1001) }), limits)).toThrow(/too large/);
    expect(() => readZip(buildZip({ a: "x".repeat(900), b: "y".repeat(900) }), limits)).toThrow(/too large/);
    const z = buildZip({ a: "x" });
    z.writeUInt16LE(1, z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8);
    expect(() => readZip(z, limits)).toThrow(/encrypted/);
  });
  it("zip-bom: een ingang die groter uitpakt dan opgegeven wordt geweigerd", () => {
    const z = buildZip({ a: "x".repeat(2000) });
    // zet de opgegeven (ongecomprimeerde) grootte in de centrale directory op 100 terwijl er 2000 uitpakt
    z.writeUInt32LE(100, z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
    expect(() => readZip(z, limits)[0]!.read()).toThrow(/cannot extract/);
  });
});

describe("fetchBytes", () => {
  const stub = (res: () => Response) => vi.stubGlobal("fetch", async () => res());
  it("weigert http, onbekende hosts, poorten en redirects naar andere hosts", async () => {
    const o = { hosts: ["cdn.modrinth.com"], maxBytes: 100 };
    await expect(fetchBytes("http://cdn.modrinth.com/x", o)).rejects.toThrow(/HOST_NOT_ALLOWED/);
    await expect(fetchBytes("https://evil.example/x", o)).rejects.toThrow(/HOST_NOT_ALLOWED/);
    await expect(fetchBytes("https://cdn.modrinth.com:8443/x", o)).rejects.toThrow(/HOST_NOT_ALLOWED/);
    await expect(fetchBytes("https://user:pw@cdn.modrinth.com/x", o)).rejects.toThrow(/HOST_NOT_ALLOWED/);
    stub(() => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } }));
    await expect(fetchBytes("https://cdn.modrinth.com/x", o)).rejects.toThrow(/HOST_NOT_ALLOWED/);
  });
  it("kapt te grote antwoorden af, ook zonder content-length", async () => {
    const o = { hosts: ["cdn.modrinth.com"], maxBytes: 100 };
    stub(() => new Response("x".repeat(500)));
    await expect(fetchBytes("https://cdn.modrinth.com/x", o)).rejects.toThrow(/TOO_LARGE/);
    stub(() => new Response("ok"));
    expect((await fetchBytes("https://cdn.modrinth.com/x", o)).toString()).toBe("ok");
  });
});
