import { crc32, inflateRawSync } from "node:zlib";
import { expect } from "vitest";

/** Reads the archive back through its central directory, as an unzip tool would. */
export function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const dataStart = local + 30 + zip.readUInt16LE(local + 26);
    const body = zip.subarray(dataStart, dataStart + compressed);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(crc32(data)).toBe(crc);
    files.set(name, data);
    at += 46 + nameLength;
  }
  return files;
}
