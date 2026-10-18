import { StoredFile, type FileStatus } from "../../domain/entities/StoredFile.js";
import type { FileKind, FileVisibility } from "../../domain/files/FileKinds.js";
import type { IFileRepository } from "../../domain/repositories/IFileRepository.js";
import type { Queryable } from "../database/postgres/Queryable.js";

type Row = {
  id: string;
  kind: FileKind;
  storage_key: string;
  visibility: FileVisibility;
  filename: string;
  content_type: string;
  size_bytes: string;
  status: FileStatus;
  owner_type: string | null;
  owner_id: string | null;
  uploaded_by: string | null;
  created_at: Date;
  completed_at: Date | null;
  deleted_at: Date | null;
};

const COLUMNS = `id, kind, storage_key, visibility, filename, content_type, size_bytes, status,
  owner_type, owner_id, uploaded_by, created_at, completed_at, deleted_at`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toEntity = (r: Row) =>
  StoredFile.restore({
    id: r.id,
    kind: r.kind,
    storageKey: r.storage_key,
    visibility: r.visibility,
    filename: r.filename,
    contentType: r.content_type,
    sizeBytes: Number(r.size_bytes),
    status: r.status,
    ownerType: r.owner_type,
    ownerId: r.owner_id,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    deletedAt: r.deleted_at,
  });

/**
 * File records in `files` (tenant database, through the tenant transaction) or `platform_files`
 * (platform database). `db` returns the handle to query with.
 */
export class PostgresFileRepository implements IFileRepository {
  constructor(
    private readonly db: () => Queryable,
    private readonly table: "files" | "platform_files",
  ) {}

  findById(id: string): Promise<StoredFile | null> {
    return this.one(id, "");
  }

  lockById(id: string): Promise<StoredFile | null> {
    return this.one(id, " for update");
  }

  async listByOwner(ownerType: string, ownerId: string): Promise<StoredFile[]> {
    if (!UUID.test(ownerId)) return [];
    const { rows } = await this.db().query<Row>(
      `select ${COLUMNS} from ${this.table}
        where owner_type = $1 and owner_id = $2 and status = 'ready'
        order by created_at desc`,
      [ownerType, ownerId],
    );
    return rows.map(toEntity);
  }

  async countByOwner(ownerType: string, ownerId: string): Promise<number> {
    if (!UUID.test(ownerId)) return 0;
    const { rows } = await this.db().query<{ n: string }>(
      `select count(*) as n from ${this.table}
        where owner_type = $1 and owner_id = $2 and status <> 'deleted'`,
      [ownerType, ownerId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async abandoned(before: Date, limit: number): Promise<StoredFile[]> {
    const { rows } = await this.db().query<Row>(
      `select ${COLUMNS} from ${this.table}
        where status = 'pending' and created_at < $1
        order by created_at limit $2`,
      [before, limit],
    );
    return rows.map(toEntity);
  }

  async save(file: StoredFile): Promise<void> {
    const s = file.snapshot();
    await this.db().query(
      `insert into ${this.table}
         (id, kind, storage_key, visibility, filename, content_type, size_bytes, status,
          owner_type, owner_id, uploaded_by, created_at, completed_at, deleted_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (id) do update set
         status = excluded.status, completed_at = excluded.completed_at,
         deleted_at = excluded.deleted_at`,
      [
        s.id,
        s.kind,
        s.storageKey,
        s.visibility,
        s.filename,
        s.contentType,
        s.sizeBytes,
        s.status,
        s.ownerType,
        s.ownerId,
        s.uploadedBy,
        s.createdAt,
        s.completedAt,
        s.deletedAt,
      ],
    );
  }

  private async one(id: string, lock: string): Promise<StoredFile | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db().query<Row>(
      `select ${COLUMNS} from ${this.table} where id = $1${lock}`,
      [id],
    );
    return rows[0] === undefined ? null : toEntity(rows[0]);
  }
}
