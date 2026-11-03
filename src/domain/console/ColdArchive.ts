import { DomainError } from "../errors/DomainError.js";

export class ArchiveRuleError extends DomainError {
  readonly code = "ARCHIVE_RULE";
  constructor(message: string) {
    super(message);
  }
}

export class ErasureRuleError extends DomainError {
  readonly code = "ERASURE_RULE";
  constructor(message: string) {
    super(message);
  }
}

const DAY_MS = 86_400_000;

/** A tenant goes to cold archive only after this long deactivated (docs/26 §8). */
export const ARCHIVE_AFTER_DAYS = 365;
/** Every archive is restored into a scratch database at least this often (docs/26 §8). */
export const ARCHIVE_VERIFY_EVERY_DAYS = 365;
/** An approved restore not carried out by then is flagged. */
export const RESTORE_WAITING_ALERT_DAYS = 2;

export type ArchiveStatus =
  "queued" | "archiving" | "archived" | "failed" | "restoring" | "restored";

/**
 * Whether a tenant may be moved to cold archive (decision 495): deactivated for at least a year,
 * not being moved between clusters, with a database, and no archive already under way.
 */
export function checkArchive(
  tenant: Readonly<{
    status: string;
    statusChangedAt: Date | null;
    hasDatabase: boolean;
    moving: boolean;
  }>,
  openArchive: boolean,
  now: Date,
): void {
  if (tenant.status !== "deactivated")
    throw new ArchiveRuleError("Only a deactivated tenant can be archived");
  const since = tenant.statusChangedAt;
  if (since === null || now.getTime() - since.getTime() < ARCHIVE_AFTER_DAYS * DAY_MS)
    throw new ArchiveRuleError(
      `A tenant is archived after ${ARCHIVE_AFTER_DAYS} days deactivated` +
        (since === null ? "" : ` (deactivated on ${since.toISOString().slice(0, 10)})`),
    );
  if (openArchive) throw new ArchiveRuleError("The tenant is already being archived");
  if (tenant.moving) throw new ArchiveRuleError("The tenant is being moved to another cluster");
  if (!tenant.hasDatabase) throw new ArchiveRuleError("The tenant has no database");
}

/** An archive is due its yearly restore test once a year has passed since the last one. */
export function verificationDue(
  archive: Readonly<{
    status: ArchiveStatus;
    archivedAt: Date | null;
    lastVerifiedAt: Date | null;
  }>,
  now: Date,
): boolean {
  if (archive.status !== "archived") return false;
  const last = archive.lastVerifiedAt ?? archive.archivedAt;
  return last === null || now.getTime() - last.getTime() >= ARCHIVE_VERIFY_EVERY_DAYS * DAY_MS;
}

export const ERASURE_SUBJECTS = ["driver", "customer", "user", "lead"] as const;
/** The people whose personal data can be erased in a tenant (decision 498). */
export type ErasureSubject = (typeof ERASURE_SUBJECTS)[number];
