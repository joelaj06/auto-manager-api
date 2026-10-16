import { StaffAccount, type StaffStatus } from "../../domain/entities/StaffAccount.js";
import type { IStaffAccountRepository } from "../../domain/repositories/IStaffAccountRepository.js";
import type { PlatformDb } from "./PlatformDb.js";

type Row = {
  id: string;
  email: string;
  name: string;
  status: StaffStatus;
  password_hash: string | null;
  totp_secret_enc: string | null;
  totp_enrolled_at: Date | null;
  totp_last_step: string | null;
  permission_version: number;
  failed_attempts: number;
  locked_until: Date | null;
  last_login_at: Date | null;
};

const COLUMNS = `id, email::text as email, name, status, password_hash, totp_secret_enc,
  totp_enrolled_at, totp_last_step, permission_version, failed_attempts, locked_until, last_login_at`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toEntity = (row: Row) =>
  StaffAccount.restore({
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    passwordHash: row.password_hash,
    totpSecretSealed: row.totp_secret_enc,
    totpEnrolledAt: row.totp_enrolled_at,
    totpLastStep: row.totp_last_step === null ? null : Number(row.totp_last_step),
    permissionVersion: row.permission_version,
    failedAttempts: row.failed_attempts,
    lockedUntil: row.locked_until,
    lastLoginAt: row.last_login_at,
  });

export class PostgresStaffAccountRepository implements IStaffAccountRepository {
  constructor(private readonly db: PlatformDb) {}

  findById(id: string): Promise<StaffAccount | null> {
    return this.one("id = $1", id, "");
  }

  findByEmail(email: string): Promise<StaffAccount | null> {
    return this.one("email = $1", email, "");
  }

  lockById(id: string): Promise<StaffAccount | null> {
    return this.one("id = $1", id, " for update");
  }

  async list(): Promise<StaffAccount[]> {
    const { rows } = await this.db.query<Row>(
      `select ${COLUMNS} from platform_users order by status, email`,
    );
    return rows.map(toEntity);
  }

  async save(account: StaffAccount, invitedBy: string | null = null): Promise<void> {
    const s = account.snapshot();
    await this.db.query(
      `insert into platform_users
         (id, email, name, status, password_hash, totp_secret_enc, totp_enrolled_at, totp_last_step,
          permission_version, failed_attempts, locked_until, last_login_at, invited_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (id) do update set
         name = excluded.name, status = excluded.status, password_hash = excluded.password_hash,
         totp_secret_enc = excluded.totp_secret_enc, totp_enrolled_at = excluded.totp_enrolled_at,
         totp_last_step = excluded.totp_last_step, permission_version = excluded.permission_version,
         failed_attempts = excluded.failed_attempts, locked_until = excluded.locked_until,
         last_login_at = excluded.last_login_at, updated_at = now()`,
      [
        s.id,
        s.email,
        s.name,
        s.status,
        s.passwordHash,
        s.totpSecretSealed,
        s.totpEnrolledAt,
        s.totpLastStep,
        s.permissionVersion,
        s.failedAttempts,
        s.lockedUntil,
        s.lastLoginAt,
        invitedBy,
      ],
    );
  }

  private async one(condition: string, value: string, lock: string): Promise<StaffAccount | null> {
    if (condition.startsWith("id") && !UUID.test(value)) return null;
    const { rows } = await this.db.query<Row>(
      `select ${COLUMNS} from platform_users where ${condition}${lock}`,
      [value],
    );
    return rows[0] === undefined ? null : toEntity(rows[0]);
  }
}
