import type { FileVisibility } from "../../domain/files/FileKinds.js";

export type PresignedUpload = Readonly<{
  method: "PUT";
  url: string;
  /** Headers the client must send with the upload, exactly as given. */
  headers: Readonly<Record<string, string>>;
  expiresAt: Date;
}>;

export type StoredObject = Readonly<{ sizeBytes: number; contentType: string | null }>;

/**
 * S3-compatible object storage (docs/03 §12). Public objects live in a separate bucket served
 * through a CDN; private ones are only reachable through short-lived signed URLs.
 */
export interface IObjectStorage {
  presignUpload(params: {
    visibility: FileVisibility;
    key: string;
    contentType: string;
    sizeBytes: number;
    expiresInSeconds: number;
  }): Promise<PresignedUpload>;
  /** A signed download URL that makes browsers save the file under `filename`. */
  presignDownload(params: {
    key: string;
    filename: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<string>;
  /** The permanent URL of a public object (CDN or public bucket). */
  publicUrl(key: string): string;
  /** Size and type of a stored object, or null when nothing was uploaded. */
  stat(visibility: FileVisibility, key: string): Promise<StoredObject | null>;
  /** The first `bytes` bytes of an object (to check its real type). */
  readStart(visibility: FileVisibility, key: string, bytes: number): Promise<Uint8Array>;
  /** Removes the object; no error when it does not exist. */
  remove(visibility: FileVisibility, key: string): Promise<void>;
}
