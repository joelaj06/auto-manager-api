import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

/**
 * Encryption of backup files (docs/26 §3: encrypted at rest; the server can write backups but
 * cannot read them).
 *
 * Each file gets a fresh 256-bit key, wrapped with the backup RSA public key (OAEP, SHA-256).
 * The private key lives off the server and is needed only to restore. The payload is split into
 * 64 KiB chunks, each sealed with AES-256-GCM; the nonce carries the chunk counter and a "last
 * chunk" flag, and the header is authenticated with every chunk — so tampering, reordering,
 * truncation and appending are all detected (the STREAM construction, as used by `age`).
 *
 * File layout (version 1):
 *   "AFBK" | 0x01 | key fingerprint (32) | wrapped key length (uint16) | wrapped key | nonce prefix (7)
 *   chunk* — 64 KiB of ciphertext + 16-byte tag; the last chunk is shorter (possibly empty + tag)
 */
const MAGIC = Buffer.from("AFBK");
const VERSION = 1;
const CHUNK_SIZE = 64 * 1024;
const TAG_SIZE = 16;
const NONCE_PREFIX_SIZE = 7;
const FINGERPRINT_SIZE = 32;
const MIN_RSA_BITS = 3072;

export class BackupCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupCipherError";
  }
}

/** SHA-256 of the public key (SPKI DER), hex. Identifies which private key opens a backup. */
export function keyFingerprint(publicKey: KeyObject): string {
  return createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
}

export function loadBackupPublicKey(pem: string): KeyObject {
  const key = createPublicKey(pem);
  assertStrongRsa(key);
  return key;
}

export function loadBackupPrivateKey(pem: string, passphrase?: string): KeyObject {
  const key = createPrivateKey(passphrase === undefined ? pem : { key: pem, passphrase });
  assertStrongRsa(key);
  return key;
}

function assertStrongRsa(key: KeyObject): void {
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== "rsa" || bits < MIN_RSA_BITS) {
    throw new BackupCipherError(`Backup keys must be RSA with at least ${MIN_RSA_BITS} bits`);
  }
}

function nonce(prefix: Buffer, counter: number, last: boolean): Buffer {
  const value = Buffer.alloc(12);
  prefix.copy(value, 0);
  value.writeUInt32BE(counter, NONCE_PREFIX_SIZE);
  value[11] = last ? 1 : 0;
  return value;
}

function seal(key: Buffer, iv: Buffer, header: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function open(key: Buffer, iv: Buffer, header: Buffer, sealed: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_SIZE));
  try {
    return Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - TAG_SIZE)),
      decipher.final(),
    ]);
  } catch {
    throw new BackupCipherError("Backup file is corrupted, truncated or was modified");
  }
}

/** Encrypts a stream for the given backup public key. */
export class BackupEncryptStream extends Transform {
  private readonly key = randomBytes(32);
  private readonly prefix = randomBytes(NONCE_PREFIX_SIZE);
  private readonly header: Buffer;
  private pending: Buffer = Buffer.alloc(0);
  private counter = 0;

  constructor(publicKey: KeyObject) {
    super();
    assertStrongRsa(publicKey);
    const wrapped = publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      this.key,
    );
    const length = Buffer.alloc(2);
    length.writeUInt16BE(wrapped.length);
    this.header = Buffer.concat([
      MAGIC,
      Buffer.from([VERSION]),
      Buffer.from(keyFingerprint(publicKey), "hex"),
      length,
      wrapped,
      this.prefix,
    ]);
    this.push(this.header);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    // Keep at least one byte back: the last chunk must be sealed with the "last" flag.
    while (this.pending.length > CHUNK_SIZE) {
      this.push(this.sealNext(this.pending.subarray(0, CHUNK_SIZE), false));
      this.pending = this.pending.subarray(CHUNK_SIZE);
    }
    done();
  }

  override _flush(done: TransformCallback): void {
    this.push(this.sealNext(this.pending, true));
    this.pending = Buffer.alloc(0);
    done();
  }

  private sealNext(plaintext: Buffer, last: boolean): Buffer {
    if (this.counter === 0xffffffff) throw new BackupCipherError("Backup too large");
    return seal(this.key, nonce(this.prefix, this.counter++, last), this.header, plaintext);
  }
}

/** Decrypts a backup file stream; fails on any modification. */
export class BackupDecryptStream extends Transform {
  private buffer: Buffer = Buffer.alloc(0);
  private header: Buffer | null = null;
  private key: Buffer | null = null;
  private prefix: Buffer | null = null;
  private counter = 0;

  constructor(private readonly privateKey: KeyObject) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    try {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      if (this.header === null && !this.readHeader()) return done();
      // A full chunk may only be opened once more data follows it (it is then not the last).
      while (this.buffer.length > CHUNK_SIZE + TAG_SIZE) {
        this.push(this.openNext(this.buffer.subarray(0, CHUNK_SIZE + TAG_SIZE), false));
        this.buffer = this.buffer.subarray(CHUNK_SIZE + TAG_SIZE);
      }
      done();
    } catch (error) {
      done(error as Error);
    }
  }

  override _flush(done: TransformCallback): void {
    try {
      if (this.header === null) throw new BackupCipherError("Not a backup file (header missing)");
      if (this.buffer.length < TAG_SIZE) {
        throw new BackupCipherError("Backup file is corrupted, truncated or was modified");
      }
      this.push(this.openNext(this.buffer, true));
      done();
    } catch (error) {
      done(error as Error);
    }
  }

  private readHeader(): boolean {
    const fixed = MAGIC.length + 1 + FINGERPRINT_SIZE + 2;
    if (this.buffer.length < fixed) return false;
    if (!this.buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new BackupCipherError("Not a backup file (bad magic)");
    }
    if (this.buffer[MAGIC.length] !== VERSION) {
      throw new BackupCipherError(`Unsupported backup format version ${this.buffer[MAGIC.length]}`);
    }
    const fingerprint = this.buffer.subarray(MAGIC.length + 1, MAGIC.length + 1 + FINGERPRINT_SIZE);
    const wrappedLength = this.buffer.readUInt16BE(fixed - 2);
    const total = fixed + wrappedLength + NONCE_PREFIX_SIZE;
    if (this.buffer.length < total) return false;

    const publicKey = createPublicKey(this.privateKey);
    if (fingerprint.toString("hex") !== keyFingerprint(publicKey)) {
      throw new BackupCipherError("This backup was encrypted for a different key");
    }
    this.key = privateDecrypt(
      { key: this.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      this.buffer.subarray(fixed, fixed + wrappedLength),
    );
    this.prefix = this.buffer.subarray(fixed + wrappedLength, total);
    this.header = this.buffer.subarray(0, total);
    this.buffer = this.buffer.subarray(total);
    return true;
  }

  private openNext(sealed: Buffer, last: boolean): Buffer {
    if (this.key === null || this.prefix === null || this.header === null) {
      throw new BackupCipherError("Backup header not read");
    }
    return open(this.key, nonce(this.prefix, this.counter++, last), this.header, sealed);
  }
}
