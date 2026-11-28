/**
 * Bestanden van een bronserver als tar-stroom (voor DaemonClient.importData):
 * - `backup`: de nieuwste geslaagde backup via de Client API (tar.gz) → gunzip. Alleen bestaande backups:
 *   een nieuwe backup maken zou de bron wijzigen, dat doen we nooit.
 * - `sftp`: Wings-SFTP (`<gebruiker>.<identifier>`, wachtwoord van dat account), recursief lezen → tar.
 *   Alleen lees-operaties (readdir, lstat, open/read); er wordt nooit geschreven of verwijderd.
 */
import type { ConnectConfig, FileEntryWithStats, SFTPWrapper } from "ssh2";
import { tarStream, type TarEntry } from "./tar";

/** ssh2 pas laden als SFTP echt nodig is (en buiten de bundel van Next, zie serverExternalPackages-standaard). */
async function loadSsh2(): Promise<typeof import("ssh2")> {
  const mod = (await import("ssh2")) as unknown as { default?: typeof import("ssh2") } & typeof import("ssh2");
  return mod.default ?? mod;
}

export interface SftpLogin {
  host: string;
  port: number;
  username: string;
  password: string;
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

/** Opent een SFTP-sessie; `close` sluit de verbinding. */
export async function openSftp(login: SftpLogin, timeoutMs = 20_000): Promise<{ sftp: SFTPWrapper; close: () => void }> {
  const { Client } = await loadSsh2();
  const conn = new Client();
  return new Promise((resolve, reject) => {
    const fail = (e: Error) => {
      conn.end();
      reject(new Error(`SFTP_FAILED: ${login.username}@${login.host}:${login.port}: ${e.message}`));
    };
    conn.once("error", fail);
    conn.once("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) return fail(err);
        conn.off("error", fail);
        conn.on("error", () => undefined);
        resolve({ sftp, close: () => conn.end() });
      });
    });
    const cfg: ConnectConfig = {
      host: login.host,
      port: login.port,
      username: login.username,
      password: login.password,
      readyTimeout: timeoutMs,
      // Wings genereert zijn eigen host-sleutel; er is geen manier om die vooraf te kennen (TOFU, alleen lezen).
      hostVerifier: () => true,
    };
    conn.connect(cfg);
  });
}

const readdir = (sftp: SFTPWrapper, path: string) =>
  new Promise<FileEntryWithStats[]>((res, rej) => sftp.readdir(path, (e, list) => (e ? rej(e) : res(list))));

/** Recursief alle mappen en gewone bestanden onder `root` (symlinks en speciale bestanden worden overgeslagen). */
export async function* walkSftp(sftp: SFTPWrapper, root = "/", skipped?: string[]): AsyncGenerator<TarEntry> {
  const stack = [root.replace(/\/+$/, "") || "/"];
  while (stack.length) {
    const dir = stack.pop()!;
    const list = await readdir(sftp, dir);
    list.sort((a, b) => a.filename.localeCompare(b.filename));
    for (const f of list) {
      if (f.filename === "." || f.filename === "..") continue;
      const full = dir === "/" ? `/${f.filename}` : `${dir}/${f.filename}`;
      const rel = full.slice(root === "/" ? 1 : root.length + 1);
      const kind = (f.attrs.mode ?? 0) & S_IFMT;
      if (kind === S_IFDIR) {
        yield { type: "dir", path: rel, mode: f.attrs.mode & 0o7777, mtime: f.attrs.mtime };
        stack.push(full);
      } else if (kind === S_IFREG || kind === 0) {
        const size = f.attrs.size ?? 0;
        yield {
          type: "file",
          path: rel,
          size,
          mode: (f.attrs.mode ?? 0o644) & 0o7777,
          mtime: f.attrs.mtime,
          open: () => sftp.createReadStream(full, { highWaterMark: 64 * 1024 }) as unknown as AsyncIterable<Uint8Array>,
        };
      } else skipped?.push(rel);
    }
  }
}

/** Tar-stroom van alle bestanden van een bronserver via SFTP. `done` sluit de verbinding (na afloop of fout). */
export async function sftpTar(login: SftpLogin, onBytes?: (n: number) => void): Promise<{ stream: ReadableStream<Uint8Array>; close: () => void }> {
  const s = await openSftp(login);
  return { stream: tarStream(walkSftp(s.sftp), onBytes), close: s.close };
}

/** Download van een backup (tar.gz) → uitgepakte tar-stroom. */
export async function backupTar(url: string, onBytes?: (n: number) => void): Promise<ReadableStream<Uint8Array>> {
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(4 * 60 * 60_000), cache: "no-store" });
  } catch (e) {
    throw new Error(`BACKUP_DOWNLOAD_FAILED: ${(e as Error).message}`);
  }
  if (!res.ok || !res.body) throw new Error(`BACKUP_DOWNLOAD_FAILED: HTTP ${res.status}`);
  const counted = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        onBytes?.(chunk.length);
        ctrl.enqueue(chunk);
      },
    }),
  );
  return counted.pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
}

