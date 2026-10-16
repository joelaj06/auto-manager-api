import type {
  ITenantNotes,
  ITenantTags,
  TagUsage,
  TenantNoteView,
} from "../../application/ports/ITenantNotes.js";
import { TenantNote } from "../../domain/entities/TenantNote.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

type ViewRow = {
  id: string;
  body: string;
  pinned: boolean;
  author_id: string;
  author_name: string;
  created_at: Date;
  updated_at: Date;
};

const VIEW = `select n.id, n.body, n.pinned, n.author_id, u.name as author_name, n.created_at, n.updated_at
                from tenant_notes n join platform_users u on u.id = n.author_id`;

const toView = (r: ViewRow): TenantNoteView => ({
  id: r.id,
  body: r.body,
  pinned: r.pinned,
  author: { id: r.author_id, name: r.author_name },
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class PostgresTenantNotes implements ITenantNotes {
  constructor(private readonly db: PlatformDb) {}

  async list(
    tenantId: string,
    options: Readonly<{ limit: number; before?: string; pinned?: boolean }>,
  ): Promise<TenantNoteView[]> {
    const { rows } = await this.db.query<ViewRow>(
      `${VIEW}
        where n.tenant_id = $1 and n.deleted_at is null
          and ($2::uuid is null or n.id < $2)
          and ($4::boolean is null or n.pinned = $4)
        order by n.id desc
        limit $3`,
      [tenantId, options.before ?? null, options.limit, options.pinned ?? null],
    );
    return rows.map(toView);
  }

  async view(noteId: string): Promise<TenantNoteView | null> {
    const { rows } = await this.db.query<ViewRow>(
      `${VIEW} where n.id = $1 and n.deleted_at is null`,
      [noteId],
    );
    return rows[0] === undefined ? null : toView(rows[0]);
  }

  async find(tenantId: string, noteId: string): Promise<TenantNote | null> {
    const { rows } = await this.db.query<{
      id: string;
      tenant_id: string;
      body: string;
      pinned: boolean;
      author_id: string;
      created_at: Date;
      updated_at: Date;
      deleted_at: Date | null;
    }>(
      `select id, tenant_id, body, pinned, author_id, created_at, updated_at, deleted_at
         from tenant_notes where id = $1 and tenant_id = $2 for update`,
      [noteId, tenantId],
    );
    const r = rows[0];
    return r === undefined
      ? null
      : TenantNote.restore({
          id: r.id,
          tenantId: r.tenant_id,
          body: r.body,
          pinned: r.pinned,
          authorId: r.author_id,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          deletedAt: r.deleted_at,
        });
  }

  async insert(note: TenantNote): Promise<void> {
    const n = note.toSnapshot();
    await this.db.query(
      `insert into tenant_notes (id, tenant_id, body, pinned, author_id, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [n.id, n.tenantId, n.body, n.pinned, n.authorId, n.createdAt, n.updatedAt],
    );
  }

  async update(note: TenantNote): Promise<void> {
    const n = note.toSnapshot();
    await this.db.query(
      `update tenant_notes set body = $2, pinned = $3, updated_at = $4, deleted_at = $5
        where id = $1`,
      [n.id, n.body, n.pinned, n.updatedAt, n.deletedAt],
    );
  }
}

export class PostgresTenantTags implements ITenantTags {
  constructor(private readonly db: PlatformDb) {}

  async of(tenantId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ tag: string }>(
      "select tag from tenant_tags where tenant_id = $1 order by tag",
      [tenantId],
    );
    return rows.map((r) => r.tag);
  }

  async replace(tenantId: string, tags: readonly string[], actorId: string): Promise<void> {
    await this.db.query("delete from tenant_tags where tenant_id = $1 and tag <> all($2)", [
      tenantId,
      tags,
    ]);
    await this.db.query(
      `insert into tenant_tags (tenant_id, tag, added_by)
       select $1, unnest($2::text[]), $3
       on conflict (tenant_id, tag) do nothing`,
      [tenantId, tags, actorId],
    );
  }

  async inUse(): Promise<TagUsage[]> {
    const { rows } = await this.db.query<{ tag: string; tenants: string }>(
      "select tag, count(*) as tenants from tenant_tags group by tag order by count(*) desc, tag",
    );
    return rows.map((r) => ({ tag: r.tag, tenants: Number(r.tenants) }));
  }
}
