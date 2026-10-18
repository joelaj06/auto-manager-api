import type { StoredFile } from "../entities/StoredFile.js";

/**
 * File records: one implementation for the tenant's database (`files`), one for the platform
 * database (`platform_files`). Writes inside the matching unit of work.
 */
export interface IFileRepository {
  findById(id: string): Promise<StoredFile | null>;
  lockById(id: string): Promise<StoredFile | null>;
  /** Ready files attached to an owner, newest first. */
  listByOwner(ownerType: string, ownerId: string): Promise<StoredFile[]>;
  countByOwner(ownerType: string, ownerId: string): Promise<number>;
  /** Pending uploads started before `before` (abandoned). */
  abandoned(before: Date, limit: number): Promise<StoredFile[]>;
  save(file: StoredFile): Promise<void>;
}
