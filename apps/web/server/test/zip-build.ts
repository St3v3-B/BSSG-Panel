/** Bouwt een zip (deflate of stored) voor tests; namen mogen kwaadaardig zijn. */
import { deflateRawSync } from "node:zlib";

function crc32(b: Buffer): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

export function buildZip(entries: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const [name, data] of Object.entries(entries)) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const comp = name.endsWith("/") ? Buffer.alloc(0) : deflateRawSync(raw);
    const nm = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(raw), 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(raw), 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nm.length, 28);
    ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, comp);
    central.push(ch, nm);
    off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
