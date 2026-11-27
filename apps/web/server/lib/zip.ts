/**
 * Minimale zip-lezer (alleen stored/deflate, geen zip64, geen versleuteling) voor .mrpack.
 * Alles blijft in het geheugen en wordt nooit uitgevoerd. Groottes worden uit de centrale
 * directory gecontroleerd vóór het uitpakken, en het uitpakken zelf is begrensd (zip-bom).
 */
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  size: number;
  isDirectory: boolean;
  read(): Buffer;
}

export class ZipError extends Error {}

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export function readZip(buf: Buffer, limits: ZipLimits): ZipEntry[] {
  const minEocd = 22;
  let eocd = -1;
  for (let i = buf.length - minEocd; i >= Math.max(0, buf.length - minEocd - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || off === 0xffffffff) throw new ZipError("zip64 is not supported");
  if (count > limits.maxEntries) throw new ZipError(`too many entries (${count})`);
  const out: ZipEntry[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw new ZipError("corrupt central directory");
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nlen).toString((flags & 0x800) !== 0 ? "utf8" : "latin1");
    off += 46 + nlen + elen + clen;
    if (flags & 1) throw new ZipError("encrypted entries are not supported");
    const isDirectory = name.endsWith("/");
    if (usize > limits.maxEntryBytes) throw new ZipError(`entry too large: ${name}`);
    total += usize;
    if (total > limits.maxTotalBytes) throw new ZipError("archive too large when extracted");
    out.push({
      name,
      size: usize,
      isDirectory,
      read() {
        if (isDirectory) return Buffer.alloc(0);
        if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new ZipError("corrupt local header");
        const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
        const data = buf.subarray(start, start + csize);
        if (data.length !== csize) throw new ZipError("truncated entry");
        let res: Buffer;
        if (method === 0) res = Buffer.from(data);
        else if (method === 8) {
          try {
            res = inflateRawSync(data, { maxOutputLength: Math.max(usize, 1) });
          } catch {
            throw new ZipError(`cannot extract ${name}`);
          }
        } else throw new ZipError(`unsupported compression method ${method}`);
        if (res.length !== usize) throw new ZipError(`size mismatch: ${name}`);
        return res;
      },
    });
  }
  return out;
}
