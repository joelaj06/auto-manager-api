import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type StoredObject = Readonly<{ sizeBytes: number; sha256: string }>;

const KEY = /^[a-z0-9][a-z0-9/_.-]{0,250}$/;

/**
 * Backup files on a local directory. Stand-in for off-site, write-only object storage (docs/26
 * §3), which replaces it when hosting is available: same keys, same operations, and — like the
 * production bucket credentials — no delete operation.
 *
 * Files are written to a temporary name and renamed when complete, so a crash never leaves a
 * partial file under a real key. Files and folders are private to the owner (0600 / 0700).
 */
export class LocalBackupStorage {
  private readonly root: string;

  constructor(directory: string) {
    this.root = resolve(directory);
  }

  /**
   * Stores `content` under `key` (which must not exist yet). `beforeCommit` runs after the last
   * byte is written and before the file gets its final name; if it throws, nothing is kept —
   * e.g. when the producer (pg_dump) exits with an error after its output ended.
   */
  async write(
    key: string,
    content: Readable,
    options: Readonly<{ beforeCommit?: () => Promise<void> }> = {},
  ): Promise<StoredObject> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const partial = `${path}.partial`;
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const measure = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        sizeBytes += chunk.length;
        done(null, chunk);
      },
    });
    try {
      await pipeline(content, measure, createWriteStream(partial, { mode: 0o600, flags: "wx" }));
      await options.beforeCommit?.();
      await rename(partial, path);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    return { sizeBytes, sha256: hash.digest("hex") };
  }

  read(key: string): Readable {
    return createReadStream(this.pathFor(key));
  }

  /** SHA-256 and size of a stored file, to check it before restoring. */
  async inspect(key: string): Promise<StoredObject> {
    const path = this.pathFor(key);
    const hash = createHash("sha256");
    await pipeline(createReadStream(path), hash);
    return { sizeBytes: (await stat(path)).size, sha256: hash.digest("hex") };
  }

  private pathFor(key: string): string {
    if (!KEY.test(key) || key.includes("..")) throw new Error(`Invalid backup key: ${key}`);
    const path = join(this.root, key);
    const inside = relative(this.root, path);
    if (inside.startsWith("..") || isAbsolute(inside))
      throw new Error(`Invalid backup key: ${key}`);
    return path;
  }
}
