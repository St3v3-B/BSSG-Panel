/** S3-toegang van het panel (alleen testen, presign en verwijderen; de daemon doet de data). */
import { randomBytes } from "node:crypto";
import { Client } from "minio";
import { decrypt } from "./crypto";

export interface S3TargetRow {
  endpoint: string;
  bucket: string;
  region: string;
  pathStyle: boolean;
  accessKeyEnc: string;
  secretKeyEnc: string;
}

/** De gegevens die de daemon per verzoek krijgt (S3Credentials in openapi.yaml). */
export function s3Credentials(t: S3TargetRow) {
  return { endpoint: t.endpoint, bucket: t.bucket, region: t.region, access_key: decrypt(t.accessKeyEnc), secret_key: decrypt(t.secretKeyEnc), path_style: t.pathStyle };
}

export function s3Client(t: S3TargetRow): Client {
  const u = new URL(t.endpoint);
  return new Client({
    endPoint: u.hostname,
    port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80,
    useSSL: u.protocol === "https:",
    accessKey: decrypt(t.accessKeyEnc),
    secretKey: decrypt(t.secretKeyEnc),
    region: t.region,
    pathStyle: t.pathStyle,
  });
}

/** Echte controle: een klein object schrijven, teruglezen en verwijderen. */
export async function testTarget(t: S3TargetRow): Promise<{ ok: boolean; error: string | null }> {
  const key = `.panel-test/${randomBytes(8).toString("hex")}`;
  try {
    const c = s3Client(t);
    const body = Buffer.from("panel s3 test");
    await c.putObject(t.bucket, key, body, body.length);
    await c.removeObject(t.bucket, key);
    return { ok: true, error: null };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, error: `${err.code ? `${err.code}: ` : ""}${err.message ?? String(e)}`.slice(0, 300) };
  }
}

export const presignGet = (t: S3TargetRow, key: string, seconds: number, filename: string) =>
  s3Client(t).presignedGetObject(t.bucket, key, seconds, { "response-content-disposition": `attachment; filename="${filename}"` });

export const removeObject = (t: S3TargetRow, key: string) => s3Client(t).removeObject(t.bucket, key);
