import { DomainError } from "../errors/DomainError.js";

export class InvalidNoteError extends DomainError {
  readonly code = "INVALID_NOTE";
  constructor(message: string) {
    super(message);
  }
}

/** Only the author may change the text of a note or delete it. */
export class NoteNotYoursError extends DomainError {
  readonly code = "NOTE_NOT_YOURS";
  constructor() {
    super("Only the author can edit or delete this note");
  }
}

export const MAX_NOTE_LENGTH = 5_000;

export type TenantNoteProps = Readonly<{
  id: string;
  tenantId: string;
  body: string;
  pinned: boolean;
  authorId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}>;

/**
 * An internal staff note on a tenant (docs/27 §3.4). Never shown to the tenant. Anyone with
 * notes access may pin or unpin; only the author edits or deletes. Deleting hides the note.
 */
export class TenantNote {
  private constructor(private props: TenantNoteProps) {}

  static write(params: {
    id: string;
    tenantId: string;
    body: string;
    pinned: boolean;
    authorId: string;
    now: Date;
  }): TenantNote {
    return new TenantNote({
      id: params.id,
      tenantId: params.tenantId,
      body: TenantNote.validBody(params.body),
      pinned: params.pinned,
      authorId: params.authorId,
      createdAt: params.now,
      updatedAt: params.now,
      deletedAt: null,
    });
  }

  static restore(props: TenantNoteProps): TenantNote {
    return new TenantNote(props);
  }

  get id(): string {
    return this.props.id;
  }
  get tenantId(): string {
    return this.props.tenantId;
  }
  get deleted(): boolean {
    return this.props.deletedAt !== null;
  }

  edit(body: string, actorId: string, now: Date): void {
    this.assertAuthor(actorId);
    this.props = { ...this.props, body: TenantNote.validBody(body), updatedAt: now };
  }

  pin(pinned: boolean, now: Date): void {
    this.props = { ...this.props, pinned, updatedAt: now };
  }

  delete(actorId: string, now: Date): void {
    this.assertAuthor(actorId);
    this.props = { ...this.props, deletedAt: now, updatedAt: now };
  }

  toSnapshot(): TenantNoteProps {
    return this.props;
  }

  private assertAuthor(actorId: string): void {
    if (actorId !== this.props.authorId) throw new NoteNotYoursError();
  }

  private static validBody(body: string): string {
    const trimmed = body.trim();
    if (trimmed.length === 0) throw new InvalidNoteError("A note cannot be empty");
    if (trimmed.length > MAX_NOTE_LENGTH)
      throw new InvalidNoteError(`A note can have at most ${MAX_NOTE_LENGTH} characters`);
    return trimmed;
  }
}
