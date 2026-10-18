import { FileStateError, type StoredFile } from "../../../domain/entities/StoredFile.js";
import type { FileKind } from "../../../domain/files/FileKinds.js";
import {
  FileNotFoundError,
  type FileService,
  type FileView,
  type UploadStarted,
} from "./FileService.js";

export type DocumentUploadInput = Readonly<{
  filename: string;
  contentType: string;
  sizeBytes: number;
}>;

/**
 * Documents attached to one owner (an application, a partner …): uploads are tied to the owner
 * from the start, a file of another owner is "not found", and the number per owner is capped.
 */
export class OwnedDocuments {
  constructor(
    private readonly files: FileService,
    private readonly kind: FileKind,
    private readonly ownerType: string,
    private readonly maxPerOwner: number,
  ) {}

  async start(
    ownerId: string,
    input: DocumentUploadInput,
    uploadedBy: string | null,
  ): Promise<UploadStarted> {
    const owner = { type: this.ownerType, id: ownerId };
    if ((await this.files.countByOwner(owner)) >= this.maxPerOwner)
      throw new FileStateError(`At most ${this.maxPerOwner} documents can be attached`);
    return this.files.startUpload({ ...input, kind: this.kind, owner, uploadedBy });
  }

  complete(ownerId: string, fileId: string): Promise<FileView> {
    return this.files.completeUpload(fileId, this.ownedBy(ownerId));
  }

  list(ownerId: string): Promise<FileView[]> {
    return this.files.listByOwner({ type: this.ownerType, id: ownerId });
  }

  get(ownerId: string, fileId: string): Promise<FileView> {
    return this.files.get(fileId, this.ownedBy(ownerId));
  }

  remove(ownerId: string, fileId: string): Promise<void> {
    return this.files.remove(fileId, this.ownedBy(ownerId));
  }

  private ownedBy(ownerId: string) {
    return (file: StoredFile): void => {
      if (file.kind !== this.kind || !file.belongsTo({ type: this.ownerType, id: ownerId }))
        throw new FileNotFoundError();
    };
  }
}
