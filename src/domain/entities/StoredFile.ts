import { DomainError } from "../errors/DomainError.js";
import {
  extensionFor,
  fileKindPolicy,
  type FileKind,
  type FileVisibility,
} from "../files/FileKinds.js";

export type FileStatus = "pending" | "ready" | "deleted";

export type StoredFileProps = Readonly<{
  id: string;
  kind: FileKind;
  /** Object key in storage, e.g. `tenants/<tenant>/organisation_logo/<id>.png`. */
  storageKey: string;
  visibility: FileVisibility;
  filename: string;
  contentType: string;
  /** Declared at upload start; must match the stored object. */
  sizeBytes: number;
  status: FileStatus;
  ownerType: string | null;
  ownerId: string | null;
  uploadedBy: string | null;
  createdAt: Date;
  completedAt: Date | null;
  deletedAt: Date | null;
}>;

/** The upload breaks the rules of its kind (type, size, name) — 400. */
export class FileRejectedError extends DomainError {
  readonly code = "FILE_REJECTED";
  constructor(message: string) {
    super(message);
  }
}

/** The file is not (or no longer) usable for this — 409. */
export class FileStateError extends DomainError {
  readonly code = "FILE_STATE";
  constructor(message: string) {
    super(message);
  }
}

const MAX_FILENAME = 200;

/**
 * A stored file (docs/03 §12). Uploads go straight to storage with a pre-signed URL:
 * `pending` (record created, URL handed out) → `ready` (object checked: size and real type) →
 * `deleted`. Only ready files can be attached to something or downloaded.
 */
export class StoredFile {
  private constructor(private props: StoredFileProps) {}

  static start(params: {
    id: string;
    kind: FileKind;
    keyPrefix: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    ownerType?: string | null;
    ownerId?: string | null;
    uploadedBy: string | null;
    now: Date;
  }): StoredFile {
    const policy = fileKindPolicy(params.kind);
    const contentType = params.contentType.trim().toLowerCase();
    if (!policy.contentTypes.includes(contentType))
      throw new FileRejectedError(
        `This file type is not accepted here (allowed: ${policy.contentTypes.join(", ")})`,
      );
    if (!Number.isInteger(params.sizeBytes) || params.sizeBytes <= 0)
      throw new FileRejectedError("The file is empty");
    if (params.sizeBytes > policy.maxBytes)
      throw new FileRejectedError(
        `The file is too large (at most ${Math.floor(policy.maxBytes / 1024 / 1024)} MB)`,
      );
    return new StoredFile({
      id: params.id,
      kind: params.kind,
      storageKey: `${params.keyPrefix}/${params.kind}/${params.id}.${extensionFor(contentType)}`,
      visibility: policy.visibility,
      filename: StoredFile.cleanName(params.filename),
      contentType,
      sizeBytes: params.sizeBytes,
      status: "pending",
      ownerType: params.ownerType ?? null,
      ownerId: params.ownerId ?? null,
      uploadedBy: params.uploadedBy,
      createdAt: params.now,
      completedAt: null,
      deletedAt: null,
    });
  }

  static restore(props: StoredFileProps): StoredFile {
    return new StoredFile(props);
  }

  get id(): string {
    return this.props.id;
  }
  get kind(): FileKind {
    return this.props.kind;
  }
  get status(): FileStatus {
    return this.props.status;
  }
  get storageKey(): string {
    return this.props.storageKey;
  }
  get visibility(): FileVisibility {
    return this.props.visibility;
  }

  /**
   * Confirms the upload from what storage actually holds: the size must match the declared one
   * and the first bytes must be of the declared type.
   */
  complete(stored: Readonly<{ sizeBytes: number; sniffedType: string | null }>, now: Date): void {
    if (this.props.status === "ready") return;
    if (this.props.status !== "pending") throw new FileStateError("This file was deleted");
    if (stored.sizeBytes !== this.props.sizeBytes)
      throw new FileRejectedError(
        `The uploaded file has ${stored.sizeBytes} bytes, ${this.props.sizeBytes} were announced`,
      );
    if (stored.sniffedType !== this.props.contentType)
      throw new FileRejectedError(`The uploaded file is not a ${this.props.contentType} file`);
    this.props = { ...this.props, status: "ready", completedAt: now };
  }

  /** Throws unless the file is ready and of `kind` (and owned by `owner`, when given). */
  assertUsableAs(kind: FileKind, owner?: Readonly<{ type: string; id: string }>): void {
    if (this.props.status !== "ready") throw new FileStateError("The file upload is not complete");
    if (this.props.kind !== kind) throw new FileStateError(`This is not a ${kind} file`);
    if (
      owner !== undefined &&
      (this.props.ownerType !== owner.type || this.props.ownerId !== owner.id)
    )
      throw new FileStateError("This file belongs to something else");
  }

  belongsTo(owner: Readonly<{ type: string; id: string }>): boolean {
    return this.props.ownerType === owner.type && this.props.ownerId === owner.id;
  }

  delete(now: Date): void {
    if (this.props.status === "deleted") return;
    this.props = { ...this.props, status: "deleted", deletedAt: now };
  }

  snapshot(): StoredFileProps {
    return this.props;
  }

  /** Keeps a readable name for downloads; drops path parts and control characters. */
  private static cleanName(filename: string): string {
    const base = filename.split("/").pop()?.split("\\").pop() ?? "";
    const clean = [...base]
      .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f && c !== '"')
      .join("")
      .trim()
      .slice(0, MAX_FILENAME);
    if (clean.length === 0) throw new FileRejectedError("The file needs a name");
    return clean;
  }
}
