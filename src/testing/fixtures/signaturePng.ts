import { crc32, deflateSync } from "node:zlib";

/** A real PNG of a drawn signature (a grey stroke on white), as the apps send it. */
export function signaturePng(width = 300, height = 90): string {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(width + 1, 255);
    row[0] = 0; // no filter
    const stroke = Math.round(height / 2 + (height / 4) * Math.sin((y / height) * Math.PI * 2));
    for (let x = 10; x < width - 10; x += 1)
      if (Math.abs((x % 60) - (stroke % 60)) < 3) row[x + 1] = 40;
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
