import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DaemonClient, DaemonHttpError } from "../daemon/client";

let srv: Server;
let base = "";
const got: Array<{ url: string; type: string; body: string }> = [];
let status = 204;

beforeAll(async () => {
  srv = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    got.push({ url: req.url!, type: String(req.headers["content-type"]), body: Buffer.concat(chunks).toString("latin1") });
    res.writeHead(status, { "content-type": "application/json" }).end(status === 204 ? undefined : JSON.stringify({ error: "disk_exceeded", message: "full" }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => srv.close());

describe("DaemonClient.uploadFile", () => {
  const file = join(mkdtempSync(join(tmpdir(), "up-")), "a.bin");
  writeFileSync(file, Buffer.from([0, 1, 2, 255, 254, 65]));
  const uuid = "c0ffee00-1234-4abc-8def-0123456789ab";

  it("posts multipart with the transfer token in the query and the binary intact", async () => {
    const c = new DaemonClient({ nodeId: 1, baseUrl: base, token: "node-token" });
    await c.uploadFile(uuid, "/.tmp", "jwt.value.here", "app.zip", file);
    const r = got.at(-1)!;
    expect(r.url).toBe(`/api/servers/${uuid}/files/upload?directory=%2F.tmp&token=jwt.value.here`);
    expect(r.type).toMatch(/^multipart\/form-data; boundary=/);
    expect(r.body).toContain('name="files"; filename="app.zip"');
    expect(r.body).toContain("\u0000\u0001\u0002ÿþA");
  });

  it("maps 507 disk_exceeded to a DaemonHttpError", async () => {
    status = 507;
    const c = new DaemonClient({ nodeId: 1, baseUrl: base, token: "t" });
    await expect(c.uploadFile(uuid, "/", "x", "a.zip", file)).rejects.toBeInstanceOf(DaemonHttpError);
    status = 204;
  });
});
