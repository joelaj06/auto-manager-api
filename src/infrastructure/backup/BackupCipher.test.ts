import { generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BackupCipherError,
  BackupDecryptStream,
  BackupEncryptStream,
  keyFingerprint,
  loadBackupPublicKey,
} from "./BackupCipher.js";

let publicKey: KeyObject;
let privateKey: KeyObject;
let otherPrivateKey: KeyObject;

beforeAll(() => {
  ({ publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 }));
  ({ privateKey: otherPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 }));
});

/** Feeds `data` in pieces of `pieceSize` bytes, to exercise chunk boundaries. */
function source(data: Buffer, pieceSize = 10_000): Readable {
  const pieces: Buffer[] = [];
  for (let i = 0; i < data.length; i += pieceSize) pieces.push(data.subarray(i, i + pieceSize));
  return Readable.from(pieces.length === 0 ? [Buffer.alloc(0)] : pieces);
}

async function encrypt(data: Buffer): Promise<Buffer> {
  const encryptor = new BackupEncryptStream(publicKey);
  const [, out] = await Promise.all([pipeline(source(data), encryptor), buffer(encryptor)]);
  return out;
}

async function decrypt(data: Buffer, key = privateKey): Promise<Buffer> {
  const decryptor = new BackupDecryptStream(key);
  const [, out] = await Promise.all([pipeline(source(data, 7_777), decryptor), buffer(decryptor)]);
  return out;
}

const KIB = 1024;

describe("backup encryption", () => {
  for (const size of [0, 1, 64 * KIB - 1, 64 * KIB, 64 * KIB + 1, 3 * 64 * KIB, 300_001]) {
    it(`round-trips ${size} bytes`, async () => {
      const data = randomBytes(size);
      const sealed = await encrypt(data);
      expect(sealed.subarray(0, 4).toString()).toBe("AFBK");
      expect((await decrypt(sealed)).equals(data)).toBe(true);
    });
  }

  it("uses a fresh key for every file", async () => {
    const data = Buffer.from("same content");
    expect((await encrypt(data)).equals(await encrypt(data))).toBe(false);
  });

  it("does not contain the plaintext", async () => {
    const marker = Buffer.from("tenant-secret-row-0123456789");
    const sealed = await encrypt(Buffer.concat([randomBytes(1_000), marker, randomBytes(1_000)]));
    expect(sealed.includes(marker)).toBe(false);
  });

  it("detects a modified byte", async () => {
    const sealed = await encrypt(randomBytes(200 * KIB));
    sealed[sealed.length - 100]! ^= 0x01;
    await expect(decrypt(sealed)).rejects.toBeInstanceOf(BackupCipherError);
  });

  it("detects truncation at a chunk boundary and appended data", async () => {
    const sealed = await encrypt(randomBytes(3 * 64 * KIB + 10));
    const headerLength = sealed.length - (3 * (64 * KIB + 16) + 10 + 16);
    const truncated = sealed.subarray(0, headerLength + 2 * (64 * KIB + 16));
    await expect(decrypt(truncated)).rejects.toBeInstanceOf(BackupCipherError);
    await expect(decrypt(Buffer.concat([sealed, randomBytes(20)]))).rejects.toBeInstanceOf(
      BackupCipherError,
    );
  });

  it("detects reordered chunks", async () => {
    const sealed = await encrypt(randomBytes(3 * 64 * KIB + 10));
    const chunk = 64 * KIB + 16;
    const headerLength = sealed.length - (3 * chunk + 10 + 16);
    const header = sealed.subarray(0, headerLength);
    const c = (i: number) =>
      sealed.subarray(headerLength + i * chunk, headerLength + (i + 1) * chunk);
    const tail = sealed.subarray(headerLength + 3 * chunk);
    const swapped = Buffer.concat([header, c(1), c(0), c(2), tail]);
    await expect(decrypt(swapped)).rejects.toBeInstanceOf(BackupCipherError);
  });

  it("refuses the wrong private key and non-backup input", async () => {
    const sealed = await encrypt(randomBytes(1_000));
    await expect(decrypt(sealed, otherPrivateKey)).rejects.toThrow(/different key/);
    await expect(decrypt(Buffer.from("PGDMP not encrypted"))).rejects.toThrow(/Not a backup/);
  });

  it("rejects weak keys", () => {
    const weak = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    expect(() =>
      loadBackupPublicKey(weak.export({ type: "spki", format: "pem" }).toString()),
    ).toThrow(/at least 3072/);
    expect(() => new BackupEncryptStream(weak)).toThrow(BackupCipherError);
  });

  it("fingerprints keys stably", () => {
    expect(keyFingerprint(publicKey)).toMatch(/^[0-9a-f]{64}$/);
    expect(keyFingerprint(publicKey)).toBe(keyFingerprint(publicKey));
  });
});
