import { FileRejectedError } from "../../../domain/entities/StoredFile.js";
import type { FileKind } from "../../../domain/files/FileKinds.js";
import type { AuthorizationPolicy } from "../../authorization/AuthorizationPolicy.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import {
  FileNotFoundError,
  type FileService,
  type FileView,
  type UploadStarted,
} from "./FileService.js";

/**
 * Who may upload each tenant file kind (the permission of what the file is for). Reading a
 * file needs the same permission unless it is public.
 */
export const TENANT_FILE_PERMISSIONS: Readonly<Partial<Record<FileKind, PermissionKey>>> =
  Object.freeze({ organisation_logo: "organisation.update" });

export type TenantUploadInput = Readonly<{
  kind: FileKind;
  filename: string;
  contentType: string;
  sizeBytes: number;
}>;

/** Tenant users' uploads (`/api/v1/files`): permission per kind; only the uploader confirms. */
export class TenantFileUploads {
  constructor(
    private readonly deps: Readonly<{ files: FileService; policy: AuthorizationPolicy }>,
  ) {}

  start(actor: Principal, input: TenantUploadInput): Promise<UploadStarted> {
    this.requireFor(actor, input.kind);
    return this.deps.files.startUpload({ ...input, uploadedBy: actor.userId });
  }

  complete(actor: Principal, fileId: string): Promise<FileView> {
    return this.deps.files.completeUpload(fileId, (file) => {
      if (file.snapshot().uploadedBy !== actor.userId) throw new FileNotFoundError();
    });
  }

  get(actor: Principal, fileId: string): Promise<FileView> {
    return this.deps.files.get(fileId, (file) => {
      if (file.visibility === "public") return;
      const permission = TENANT_FILE_PERMISSIONS[file.kind];
      if (permission === undefined || !this.deps.policy.decide(actor, permission).allowed)
        throw new FileNotFoundError();
    });
  }

  private requireFor(actor: Principal, kind: FileKind): void {
    const permission = TENANT_FILE_PERMISSIONS[kind];
    if (permission === undefined)
      throw new FileRejectedError(`Files of kind ${kind} cannot be uploaded here`);
    this.deps.policy.require(actor, permission);
  }
}
