import type { DriverListFilter, IDriverQueries } from "../../application/ports/IPartyRecords.js";
import { Driver, type DriverProps } from "../../domain/parties/Driver.js";
import type { IDriverRepository } from "../../domain/repositories/IPartyRepositories.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";
import { phoneSearchKey, UUID } from "./partySql.js";

type DriverRow = {
  id: string;
  code: string;
  first_name: string;
  last_name: string;
  other_names: string | null;
  phone: string;
  alt_phone: string | null;
  email: string | null;
  date_of_birth: string | null;
  gender: DriverProps["gender"];
  address: string | null;
  ghana_card_number: string | null;
  licence_number: string | null;
  licence_class: DriverProps["licenceClass"];
  licence_issued_on: string | null;
  licence_expires_on: string | null;
  employment_type: DriverProps["employmentType"];
  status: DriverProps["status"];
  status_reason: string | null;
  status_changed_at: Date;
  hired_on: string | null;
  terminated_on: string | null;
  branch_id: string;
  emergency_contact: DriverProps["emergencyContact"];
  payout: DriverProps["payout"];
  tags: string[];
  notes: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  deleted_reason: string | null;
};

const COLUMNS = `d.id, d.code, d.first_name, d.last_name, d.other_names, d.phone, d.alt_phone,
  d.email::text as email, d.date_of_birth::text as date_of_birth, d.gender, d.address,
  d.ghana_card_number, d.licence_number, d.licence_class,
  d.licence_issued_on::text as licence_issued_on, d.licence_expires_on::text as licence_expires_on,
  d.employment_type, d.status, d.status_reason, d.status_changed_at, d.hired_on::text as hired_on,
  d.terminated_on::text as terminated_on, d.branch_id, d.emergency_contact, d.payout, d.tags,
  d.notes, d.created_by, d.created_at, d.updated_at, d.deleted_at, d.deleted_reason`;

const toProps = (r: DriverRow): DriverProps => ({
  id: r.id,
  code: r.code,
  firstName: r.first_name,
  lastName: r.last_name,
  otherNames: r.other_names,
  phone: r.phone,
  altPhone: r.alt_phone,
  email: r.email,
  dateOfBirth: r.date_of_birth,
  gender: r.gender,
  address: r.address,
  ghanaCardNumber: r.ghana_card_number,
  licenceNumber: r.licence_number,
  licenceClass: r.licence_class,
  licenceIssuedOn: r.licence_issued_on,
  licenceExpiresOn: r.licence_expires_on,
  employmentType: r.employment_type,
  status: r.status,
  statusReason: r.status_reason,
  statusChangedAt: r.status_changed_at,
  hiredOn: r.hired_on,
  terminatedOn: r.terminated_on,
  branchId: r.branch_id,
  emergencyContact: r.emergency_contact,
  payout: r.payout,
  tags: r.tags,
  notes: r.notes,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
  deletedReason: r.deleted_reason,
});

/** Drivers in the tenant database (tenant unit of work). */
export class PostgresDriverRepository implements IDriverRepository, IDriverQueries {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async findById(id: string): Promise<Driver | null> {
    return this.one(id, "");
  }

  async lockById(id: string): Promise<Driver | null> {
    return this.one(id, "for update");
  }

  private async one(id: string, lock: string): Promise<Driver | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<DriverRow>(
      `select ${COLUMNS} from drivers d where d.id = $1 and d.deleted_at is null ${lock}`,
      [id],
    );
    return rows[0] === undefined ? null : Driver.restore(toProps(rows[0]));
  }

  async save(driver: Driver): Promise<void> {
    const p = driver.snapshot();
    await this.tx.query(
      `insert into drivers (id, code, first_name, last_name, other_names, phone, alt_phone, email,
         date_of_birth, gender, address, ghana_card_number, licence_number, licence_class,
         licence_issued_on, licence_expires_on, employment_type, status, status_reason,
         status_changed_at, hired_on, terminated_on, branch_id, emergency_contact, payout, tags,
         notes, created_by, created_at, updated_at, deleted_at, deleted_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
         $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32)
       on conflict (id) do update set first_name = excluded.first_name,
         last_name = excluded.last_name, other_names = excluded.other_names,
         phone = excluded.phone, alt_phone = excluded.alt_phone, email = excluded.email,
         date_of_birth = excluded.date_of_birth, gender = excluded.gender,
         address = excluded.address, ghana_card_number = excluded.ghana_card_number,
         licence_number = excluded.licence_number, licence_class = excluded.licence_class,
         licence_issued_on = excluded.licence_issued_on,
         licence_expires_on = excluded.licence_expires_on,
         employment_type = excluded.employment_type, status = excluded.status,
         status_reason = excluded.status_reason, status_changed_at = excluded.status_changed_at,
         hired_on = excluded.hired_on, terminated_on = excluded.terminated_on,
         branch_id = excluded.branch_id, emergency_contact = excluded.emergency_contact,
         payout = excluded.payout, tags = excluded.tags, notes = excluded.notes,
         updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
         deleted_reason = excluded.deleted_reason`,
      [
        p.id,
        p.code,
        p.firstName,
        p.lastName,
        p.otherNames,
        p.phone,
        p.altPhone,
        p.email,
        p.dateOfBirth,
        p.gender,
        p.address,
        p.ghanaCardNumber,
        p.licenceNumber,
        p.licenceClass,
        p.licenceIssuedOn,
        p.licenceExpiresOn,
        p.employmentType,
        p.status,
        p.statusReason,
        p.statusChangedAt,
        p.hiredOn,
        p.terminatedOn,
        p.branchId,
        p.emergencyContact === null ? null : JSON.stringify(p.emergencyContact),
        p.payout === null ? null : JSON.stringify(p.payout),
        p.tags,
        p.notes,
        p.createdBy,
        p.createdAt,
        p.updatedAt,
        p.deletedAt,
        p.deletedReason,
      ],
    );
  }

  phoneTaken(phone: string, exceptId: string | null): Promise<boolean> {
    return this.taken("phone = $1", phone, exceptId);
  }

  ghanaCardTaken(number: string, exceptId: string | null): Promise<boolean> {
    return this.taken("ghana_card_number = $1", number, exceptId);
  }

  licenceTaken(number: string, exceptId: string | null): Promise<boolean> {
    return this.taken("upper(licence_number) = upper($1)", number, exceptId);
  }

  private async taken(condition: string, value: string, exceptId: string | null) {
    const { rows } = await this.tx.query(
      `select 1 from drivers where ${condition} and deleted_at is null
          and ($2::uuid is null or id <> $2)`,
      [value, exceptId],
    );
    return rows.length > 0;
  }

  async list(filter: DriverListFilter): Promise<DriverProps[]> {
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = ["d.deleted_at is null", "b.status = 'active'"];
    if (filter.branchIds !== "all")
      where.push(`d.branch_id = any(${param(filter.branchIds)}::uuid[])`);
    if (filter.branchId !== undefined) where.push(`d.branch_id = ${param(filter.branchId)}`);
    if (filter.statuses !== undefined)
      where.push(`d.status = any(${param(filter.statuses)}::text[])`);
    if (filter.employmentType !== undefined)
      where.push(`d.employment_type = ${param(filter.employmentType)}`);
    if (filter.search !== undefined && filter.search.trim() !== "") {
      const text = param(filter.search.trim().toLowerCase());
      const phone = phoneSearchKey(filter.search);
      where.push(
        `(strpos(lower(d.first_name || ' ' || coalesce(d.other_names || ' ', '') || d.last_name), ${text}) > 0
          or lower(d.code) = ${text} or lower(d.licence_number) = ${text}
          ${phone === null ? "" : `or strpos(d.phone, ${param(phone)}) > 0`})`,
      );
    }
    if (filter.after !== undefined)
      where.push(
        `(d.created_at, d.id) < (${param(filter.after.createdAt)}::timestamptz, ${param(filter.after.id)}::uuid)`,
      );
    const { rows } = await this.tx.query<DriverRow>(
      `select ${COLUMNS} from drivers d join branches b on b.id = d.branch_id
        where ${where.join(" and ")}
        order by d.created_at desc, d.id desc
        limit ${param(filter.limit)}`,
      params,
    );
    return rows.map(toProps);
  }

  async countInBranch(branchId: string): Promise<number> {
    const { rows } = await this.tx.query<{ count: string }>(
      `select count(*) from drivers
        where branch_id = $1 and deleted_at is null and status <> 'terminated'`,
      [branchId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async expiringLicences(
    branchIds: "all" | readonly string[],
    until: string,
  ): Promise<DriverProps[]> {
    const { rows } = await this.tx.query<DriverRow>(
      `select ${COLUMNS} from drivers d join branches b on b.id = d.branch_id
        where d.deleted_at is null and b.status = 'active' and d.status <> 'terminated'
          and d.licence_expires_on <= $1
          and ($2::uuid[] is null or d.branch_id = any($2::uuid[]))
        order by d.licence_expires_on, d.last_name`,
      [until, branchIds === "all" ? null : branchIds],
    );
    return rows.map(toProps);
  }
}
