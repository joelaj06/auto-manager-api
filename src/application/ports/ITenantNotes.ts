import type { TenantNote } from "../../domain/entities/TenantNote.js";

export type TenantNoteView = Readonly<{
  id: string;
  body: string;
  pinned: boolean;
  author: Readonly<{ id: string; name: string }>;
  createdAt: Date;
  updatedAt: Date;
}>;

export type NoteListOptions = Readonly<{ limit: number; before?: string; pinned?: boolean }>;

/** Staff notes on a tenant, newest first; deleted notes are hidden. */
export interface ITenantNotes {
  list(tenantId: string, options: NoteListOptions): Promise<TenantNoteView[]>;
  view(noteId: string): Promise<TenantNoteView | null>;
  find(tenantId: string, noteId: string): Promise<TenantNote | null>;
  insert(note: TenantNote): Promise<void>;
  update(note: TenantNote): Promise<void>;
}

export type TagUsage = Readonly<{ tag: string; tenants: number }>;

export interface ITenantTags {
  of(tenantId: string): Promise<string[]>;
  /** Replaces the tenant's tags with `tags` (already normalised). */
  replace(tenantId: string, tags: readonly string[], actorId: string): Promise<void>;
  inUse(): Promise<TagUsage[]>;
}
