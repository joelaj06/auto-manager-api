import { crc32, deflateRawSync } from "node:zlib";

type Entry = Readonly<{
  name: Buffer;
  crc: number;
  size: number;
  compressed: number;
  offset: number;
  method: number;
}>;

/** Folders inside the archive use forward slashes; names are kept short and plain. */
const safeName = (name: string) =>
  name
    .replace(/[^\w./-]/g, "_")
    .replace(/^\/+/, "")
    .slice(0, 200);

/**
 * A minimal ZIP archive (PKWARE APPNOTE, no ZIP64): entries deflated (or stored when that does
 * not help), UTF-8 names, one central directory. Built in memory — exports are capped in size.
 */
export class ZipWriter {
  private readonly chunks: Buffer[] = [];
  private readonly entries: Entry[] = [];
  private offset = 0;

  add(name: string, data: Uint8Array): void {
    const raw = Buffer.from(data);
    const deflated = deflateRawSync(raw);
    const method = deflated.length < raw.length ? 8 : 0;
    const body = method === 8 ? deflated : raw;
    const fileName = Buffer.from(safeName(name), "utf8");
    const crc = crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(0, 10); // time, date
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(fileName.length, 26);
    header.writeUInt16LE(0, 28);
    this.entries.push({
      name: fileName,
      crc,
      size: raw.length,
      compressed: body.length,
      offset: this.offset,
      method,
    });
    this.chunks.push(header, fileName, body);
    this.offset += header.length + fileName.length + body.length;
  }

  get bytes(): number {
    return this.offset;
  }

  finish(): Buffer {
    const central: Buffer[] = [];
    let size = 0;
    for (const e of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4); // made by
      header.writeUInt16LE(20, 6); // version needed
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(e.method, 10);
      header.writeUInt32LE(0, 12);
      header.writeUInt32LE(e.crc, 16);
      header.writeUInt32LE(e.compressed, 20);
      header.writeUInt32LE(e.size, 24);
      header.writeUInt16LE(e.name.length, 28);
      header.writeUInt16LE(0, 30); // extra
      header.writeUInt16LE(0, 32); // comment
      header.writeUInt16LE(0, 34); // disk
      header.writeUInt16LE(0, 36); // internal attributes
      header.writeUInt32LE(0, 38); // external attributes
      header.writeUInt32LE(e.offset, 42);
      central.push(header, e.name);
      size += header.length + e.name.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(this.offset, 16);
    return Buffer.concat([...this.chunks, ...central, end]);
  }
}
