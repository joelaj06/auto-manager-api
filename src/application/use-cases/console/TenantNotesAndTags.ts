import { TenantNote } from "../../../domain/entities/TenantNote.js";
import { TenantTag } from "../../../domain/value-objects/TenantTag.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import { TenantNotFoundForStaffError } from "../../errors/TenantErrors.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantDirectory } from "../../ports/ITenantDirectory.js";
import type {
  ITenantNotes,
  ITenantTags,
  NoteListOptions,
  TagUsage,
  TenantNoteView,
} from "../../ports/ITenantNotes.js";
import { recordStaffAction } from "./consoleAudit.js";

export class NoteNotFoundError extends ApplicationError {
  readonly code = "NOTE_NOT_FOUND";
  constructor() {
    super("Note not found");
  }
}

/** Internal staff notes and tags on a tenant (docs/27 §3.4). Every change is audited. */
export class TenantNotesAndTags {
  constructor(
    private readonly deps: Readonly<{
      notes: ITenantNotes;
      tags: ITenantTags;
      directory: ITenantDirectory;
      unitOfWork: IPlatformUnitOfWork;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  async notes(tenantId: string, options: NoteListOptions): Promise<TenantNoteView[]> {
    await this.assertTenant(tenantId);
    return this.deps.notes.list(tenantId, options);
  }

  async addNote(
    tenantId: string,
    input: Readonly<{ body: string; pinned: boolean }>,
    actor: PlatformPrincipal,
  ): Promise<TenantNoteView> {
    await this.assertTenant(tenantId);
    const note = TenantNote.write({
      id: this.deps.ids.next(),
      tenantId,
      body: input.body,
      pinned: input.pinned,
      authorId: actor.userId,
      now: this.deps.clock.now(),
    });
    await this.deps.unitOfWork.run(async () => {
      await this.deps.notes.insert(note);
      await this.audit(actor, "tenant.note_added", note, undefined, {
        body: note.toSnapshot().body,
      });
    });
    return this.view(note.id);
  }

  async editNote(
    tenantId: string,
    noteId: string,
    changes: Readonly<{ body?: string; pinned?: boolean }>,
    actor: PlatformPrincipal,
  ): Promise<TenantNoteView> {
    await this.deps.unitOfWork.run(async () => {
      const note = await this.note(tenantId, noteId);
      const before = note.toSnapshot();
      const now = this.deps.clock.now();
      if (changes.body !== undefined && changes.body.trim() !== before.body)
        note.edit(changes.body, actor.userId, now);
      if (changes.pinned !== undefined && changes.pinned !== before.pinned)
        note.pin(changes.pinned, now);
      const after = note.toSnapshot();
      if (after === before) return;
      await this.deps.notes.update(note);
      await this.audit(
        actor,
        "tenant.note_edited",
        note,
        { body: before.body, pinned: before.pinned },
        { body: after.body, pinned: after.pinned },
      );
    });
    return this.view(noteId);
  }

  async deleteNote(tenantId: string, noteId: string, actor: PlatformPrincipal): Promise<void> {
    await this.deps.unitOfWork.run(async () => {
      const note = await this.note(tenantId, noteId);
      const before = note.toSnapshot();
      note.delete(actor.userId, this.deps.clock.now());
      await this.deps.notes.update(note);
      await this.audit(actor, "tenant.note_deleted", note, { body: before.body }, undefined);
    });
  }

  async tags(tenantId: string): Promise<string[]> {
    await this.assertTenant(tenantId);
    return this.deps.tags.of(tenantId);
  }

  async setTags(
    tenantId: string,
    input: readonly string[],
    actor: PlatformPrincipal,
  ): Promise<string[]> {
    const tags = TenantTag.set(input);
    await this.assertTenant(tenantId);
    await this.deps.unitOfWork.run(async () => {
      const before = await this.deps.tags.of(tenantId);
      if (before.join() === tags.join()) return;
      await this.deps.tags.replace(tenantId, tags, actor.userId);
      await recordStaffAction(this.deps, actor, {
        action: "tenant.tags_changed",
        entityType: "tenant",
        entityId: tenantId,
        targetTenantId: tenantId,
        before: { tags: before },
        after: { tags },
      });
    });
    return tags;
  }

  tagsInUse(): Promise<TagUsage[]> {
    return this.deps.tags.inUse();
  }

  private async assertTenant(tenantId: string): Promise<void> {
    if ((await this.deps.directory.findById(tenantId)) === null)
      throw new TenantNotFoundForStaffError();
  }

  private async note(tenantId: string, noteId: string): Promise<TenantNote> {
    const note = await this.deps.notes.find(tenantId, noteId);
    if (note === null || note.deleted) throw new NoteNotFoundError();
    return note;
  }

  private async view(noteId: string): Promise<TenantNoteView> {
    const view = await this.deps.notes.view(noteId);
    if (view === null) throw new NoteNotFoundError();
    return view;
  }

  private audit(
    actor: PlatformPrincipal,
    action: string,
    note: TenantNote,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    return recordStaffAction(this.deps, actor, {
      action,
      entityType: "tenant_note",
      entityId: note.id,
      targetTenantId: note.tenantId,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    });
  }
}
