import {
  FileRejectedError,
  FileStateError,
  StoredFile,
} from "../../../domain/entities/StoredFile.js";
import {
  fileKindPolicy,
  SNIFF_BYTES,
  sniffContentType,
  type FileKind,
  type FileScope,
} from "../../../domain/files/FileKinds.js";
import type { IFileRepository } from "../../../domain/repositories/IFileRepository.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IObjectStorage, PresignedUpload } from "../../ports/IObjectStorage.js";

export class FileNotFoundError extends ApplicationError {
  readonly code = "FILE_NOT_FOUND";
  constructor() {
    super("File not found");
  }
}

export type FileView = Readonly<{
  id: string;
  kind: FileKind;
  filename: string;
  contentType: string;
  sizeBytes: number;
  status: StoredFile["status"];
  visibility: StoredFile["visibility"];
  createdAt: Date;
  /** Public URL, or a short-lived signed URL for private files; null until ready. */
  url: string | null;
  urlExpiresAt: Date | null;
}>;

export type UploadStarted = Readonly<{ file: FileView; upload: PresignedUpload }>;

export type StartUploadInput = Readonly<{
  kind: FileKind;
  filename: string;
  contentType: string;
  sizeBytes: number;
  owner?: Readonly<{ type: string; id: string }>;
  uploadedBy: string | null;
}>;

export type FileServiceSettings = Readonly<{
  uploadUrlTtlSeconds: number;
  downloadUrlTtlSeconds: number;
  /** Pending uploads older than this are removed by the sweep. */
  abandonAfterHours: number;
}>;

export const DEFAULT_FILE_SETTINGS: FileServiceSettings = Object.freeze({
  uploadUrlTtlSeconds: 15 * 60,
  downloadUrlTtlSeconds: 5 * 60,
  abandonAfterHours: 24,
});

const SWEEP_BATCH = 200;

/**
 * Uploads with pre-signed URLs (docs/03 §12): the client asks for an upload URL, sends the bytes
 * straight to storage, then confirms; the confirmation checks size and the real file type before
 * the file can be used. One instance per scope (tenant files or platform files). Callers decide
 * who may upload or read which kind and owner.
 */
export class FileService {
  constructor(
    private readonly deps: Readonly<{
      scope: FileScope;
      files: IFileRepository;
      storage: IObjectStorage;
      unitOfWork: Readonly<{ run<T>(work: () => Promise<T>): Promise<T> }>;
      /** Storage key prefix for new files, e.g. `tenants/<id>` (evaluated per upload). */
      keyPrefix: () => string;
      ids: IIdGenerator;
      clock: IClock;
      settings?: FileServiceSettings;
    }>,
  ) {}

  private get settings(): FileServiceSettings {
    return this.deps.settings ?? DEFAULT_FILE_SETTINGS;
  }

  async startUpload(input: StartUploadInput): Promise<UploadStarted> {
    const { deps } = this;
    if (fileKindPolicy(input.kind).scope !== deps.scope)
      throw new FileRejectedError(`Files of kind ${input.kind} cannot be uploaded here`);
    const file = StoredFile.start({
      id: deps.ids.next(),
      kind: input.kind,
      keyPrefix: deps.keyPrefix(),
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      ownerType: input.owner?.type ?? null,
      ownerId: input.owner?.id ?? null,
      uploadedBy: input.uploadedBy,
      now: deps.clock.now(),
    });
    await deps.unitOfWork.run(() => deps.files.save(file));
    const s = file.snapshot();
    const upload = await deps.storage.presignUpload({
      visibility: s.visibility,
      key: s.storageKey,
      contentType: s.contentType,
      sizeBytes: s.sizeBytes,
      expiresInSeconds: this.settings.uploadUrlTtlSeconds,
    });
    return { file: await this.view(file), upload };
  }

  /**
   * Confirms an upload. A file that is not what was announced (size or real type) is deleted
   * from storage and refused.
   */
  async completeUpload(
    fileId: string,
    check: (file: StoredFile) => void = () => undefined,
  ): Promise<FileView> {
    const { deps } = this;
    const file = await this.find(fileId);
    check(file);
    if (file.status === "ready") return this.view(file);
    if (file.status !== "pending") throw new FileStateError("This file was deleted");
    const stored = await deps.storage.stat(file.visibility, file.storageKey);
    if (stored === null) throw new FileStateError("Nothing has been uploaded for this file yet");
    const head = await deps.storage.readStart(file.visibility, file.storageKey, SNIFF_BYTES);
    try {
      await deps.unitOfWork.run(async () => {
        const locked = await deps.files.lockById(fileId);
        if (locked === null) throw new FileNotFoundError();
        locked.complete(
          { sizeBytes: stored.sizeBytes, sniffedType: sniffContentType(head) },
          deps.clock.now(),
        );
        await deps.files.save(locked);
      });
    } catch (error) {
      if (error instanceof FileRejectedError) await this.discard(fileId);
      throw error;
    }
    return this.view(await this.find(fileId));
  }

  /**
   * Stores a file the server generated (an issued document's PDF): written to storage first,
   * then recorded as ready — a crash in between leaves only an orphan object, never a record
   * without bytes.
   */
  async storeGenerated(
    input: Readonly<{
      kind: FileKind;
      filename: string;
      contentType: string;
      content: Uint8Array;
      owner?: Readonly<{ type: string; id: string }>;
      createdBy: string | null;
    }>,
  ): Promise<StoredFile> {
    const { deps } = this;
    if (fileKindPolicy(input.kind).scope !== deps.scope)
      throw new FileRejectedError(`Files of kind ${input.kind} cannot be stored here`);
    const now = deps.clock.now();
    const file = StoredFile.start({
      id: deps.ids.next(),
      kind: input.kind,
      keyPrefix: deps.keyPrefix(),
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: input.content.length,
      ownerType: input.owner?.type ?? null,
      ownerId: input.owner?.id ?? null,
      uploadedBy: input.createdBy,
      now,
    });
    await deps.storage.put(file.visibility, file.storageKey, input.content, input.contentType);
    file.complete(
      {
        sizeBytes: input.content.length,
        sniffedType: sniffContentType(input.content.subarray(0, SNIFF_BYTES)),
      },
      now,
    );
    await deps.unitOfWork.run(() => deps.files.save(file));
    return file;
  }

  /** The bytes of a ready file (generated documents: small). */
  async read(fileId: string): Promise<Uint8Array> {
    const file = await this.find(fileId);
    if (file.status !== "ready") throw new FileNotFoundError();
    return this.deps.storage.read(file.visibility, file.storageKey);
  }

  async get(
    fileId: string,
    check: (file: StoredFile) => void = () => undefined,
  ): Promise<FileView> {
    const file = await this.find(fileId);
    check(file);
    if (file.status === "deleted") throw new FileNotFoundError();
    return this.view(file);
  }

  async listByOwner(owner: Readonly<{ type: string; id: string }>): Promise<FileView[]> {
    const { deps } = this;
    const files = await deps.unitOfWork.run(() => deps.files.listByOwner(owner.type, owner.id));
    return Promise.all(files.map((file) => this.view(file)));
  }

  countByOwner(owner: Readonly<{ type: string; id: string }>): Promise<number> {
    const { deps } = this;
    return deps.unitOfWork.run(() => deps.files.countByOwner(owner.type, owner.id));
  }

  /** The file entity, for callers that attach it to something (and check it first). */
  async load(fileId: string): Promise<StoredFile> {
    return this.find(fileId);
  }

  async remove(fileId: string, check: (file: StoredFile) => void = () => undefined): Promise<void> {
    const file = await this.find(fileId);
    check(file);
    await this.discard(fileId);
  }

  /** Deletes abandoned uploads (records and any bytes). Returns how many. */
  async sweepAbandoned(): Promise<number> {
    const before = new Date(
      this.deps.clock.now().getTime() - this.settings.abandonAfterHours * 3_600_000,
    );
    const { deps } = this;
    const files = await deps.unitOfWork.run(() => deps.files.abandoned(before, SWEEP_BATCH));
    for (const file of files) await this.discard(file.id);
    return files.length;
  }

  async view(file: StoredFile): Promise<FileView> {
    const s = file.snapshot();
    let url: string | null = null;
    let urlExpiresAt: Date | null = null;
    if (s.status === "ready") {
      if (s.visibility === "public") url = this.deps.storage.publicUrl(s.storageKey);
      else {
        const ttl = this.settings.downloadUrlTtlSeconds;
        url = await this.deps.storage.presignDownload({
          key: s.storageKey,
          filename: s.filename,
          contentType: s.contentType,
          expiresInSeconds: ttl,
        });
        urlExpiresAt = new Date(this.deps.clock.now().getTime() + ttl * 1_000);
      }
    }
    return {
      id: s.id,
      kind: s.kind,
      filename: s.filename,
      contentType: s.contentType,
      sizeBytes: s.sizeBytes,
      status: s.status,
      visibility: s.visibility,
      createdAt: s.createdAt,
      url,
      urlExpiresAt,
    };
  }

  private async find(fileId: string): Promise<StoredFile> {
    const { deps } = this;
    const file = await deps.unitOfWork.run(() => deps.files.findById(fileId));
    if (file === null) throw new FileNotFoundError();
    return file;
  }

  private async discard(fileId: string): Promise<void> {
    const { deps } = this;
    const file = await deps.unitOfWork.run(async () => {
      const locked = await deps.files.lockById(fileId);
      if (locked === null) return null;
      locked.delete(deps.clock.now());
      await deps.files.save(locked);
      return locked;
    });
    if (file !== null) await deps.storage.remove(file.visibility, file.storageKey);
  }
}
