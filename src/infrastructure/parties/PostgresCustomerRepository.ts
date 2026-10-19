import type {
  CustomerListFilter,
  ICustomerQueries,
} from "../../application/ports/IPartyRecords.js";
import { Customer, type CustomerProps } from "../../domain/parties/Customer.js";
import type { ICustomerRepository } from "../../domain/repositories/IPartyRepositories.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";
import { phoneSearchKey, UUID } from "./partySql.js";

type CustomerRow = {
  id: string;
  code: string;
  type: CustomerProps["type"];
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  name: string;
  phone: string | null;
  alt_phone: string | null;
  email: string | null;
  address: string | null;
  date_of_birth: string | null;
  occupation: string | null;
  ghana_card_number: string | null;
  licence_number: string | null;
  licence_class: CustomerProps["licenceClass"];
  licence_expires_on: string | null;
  registration_number: string | null;
  tin: string | null;
  contact_person: string | null;
  credit_limit_minor: string | null;
  payment_terms_days: number | null;
  risk_status: CustomerProps["riskStatus"];
  risk_reason: string | null;
  risk_changed_at: Date | null;
  source: CustomerProps["source"];
  home_branch_id: string | null;
  tags: string[];
  notes: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  deleted_reason: string | null;
};

const COLUMNS = `id, code, type, first_name, last_name, company_name, name, phone, alt_phone,
  email::text as email, address, date_of_birth::text as date_of_birth, occupation,
  ghana_card_number, licence_number, licence_class, licence_expires_on::text as licence_expires_on,
  registration_number, tin, contact_person, credit_limit_minor, payment_terms_days, risk_status,
  risk_reason, risk_changed_at, source, home_branch_id, tags, notes, created_by, created_at,
  updated_at, deleted_at, deleted_reason`;

const toProps = (r: CustomerRow): CustomerProps => ({
  id: r.id,
  code: r.code,
  type: r.type,
  firstName: r.first_name,
  lastName: r.last_name,
  companyName: r.company_name,
  name: r.name,
  phone: r.phone,
  altPhone: r.alt_phone,
  email: r.email,
  address: r.address,
  dateOfBirth: r.date_of_birth,
  occupation: r.occupation,
  ghanaCardNumber: r.ghana_card_number,
  licenceNumber: r.licence_number,
  licenceClass: r.licence_class,
  licenceExpiresOn: r.licence_expires_on,
  registrationNumber: r.registration_number,
  tin: r.tin,
  contactPerson: r.contact_person,
  creditLimitMinor: r.credit_limit_minor === null ? null : Number(r.credit_limit_minor),
  paymentTermsDays: r.payment_terms_days,
  riskStatus: r.risk_status,
  riskReason: r.risk_reason,
  riskChangedAt: r.risk_changed_at,
  source: r.source,
  homeBranchId: r.home_branch_id,
  tags: r.tags,
  notes: r.notes,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
  deletedReason: r.deleted_reason,
});

/** Customers in the tenant database (tenant unit of work). */
export class PostgresCustomerRepository implements ICustomerRepository, ICustomerQueries {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async findById(id: string): Promise<Customer | null> {
    return this.one(id, "");
  }

  async lockById(id: string): Promise<Customer | null> {
    return this.one(id, "for update");
  }

  private async one(id: string, lock: string): Promise<Customer | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<CustomerRow>(
      `select ${COLUMNS} from customers where id = $1 and deleted_at is null ${lock}`,
      [id],
    );
    return rows[0] === undefined ? null : Customer.restore(toProps(rows[0]));
  }

  async save(customer: Customer): Promise<void> {
    const p = customer.snapshot();
    await this.tx.query(
      `insert into customers (id, code, type, first_name, last_name, company_name, name, phone,
         alt_phone, email, address, date_of_birth, occupation, ghana_card_number, licence_number,
         licence_class, licence_expires_on, registration_number, tin, contact_person,
         credit_limit_minor, payment_terms_days, risk_status, risk_reason, risk_changed_at,
         source, home_branch_id, tags, notes, created_by, created_at, updated_at, deleted_at,
         deleted_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
         $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34)
       on conflict (id) do update set type = excluded.type, first_name = excluded.first_name,
         last_name = excluded.last_name, company_name = excluded.company_name,
         name = excluded.name, phone = excluded.phone, alt_phone = excluded.alt_phone,
         email = excluded.email, address = excluded.address,
         date_of_birth = excluded.date_of_birth, occupation = excluded.occupation,
         ghana_card_number = excluded.ghana_card_number,
         licence_number = excluded.licence_number, licence_class = excluded.licence_class,
         licence_expires_on = excluded.licence_expires_on,
         registration_number = excluded.registration_number, tin = excluded.tin,
         contact_person = excluded.contact_person,
         credit_limit_minor = excluded.credit_limit_minor,
         payment_terms_days = excluded.payment_terms_days, risk_status = excluded.risk_status,
         risk_reason = excluded.risk_reason, risk_changed_at = excluded.risk_changed_at,
         source = excluded.source, home_branch_id = excluded.home_branch_id,
         tags = excluded.tags, notes = excluded.notes, updated_at = excluded.updated_at,
         deleted_at = excluded.deleted_at, deleted_reason = excluded.deleted_reason`,
      [
        p.id,
        p.code,
        p.type,
        p.firstName,
        p.lastName,
        p.companyName,
        p.name,
        p.phone,
        p.altPhone,
        p.email,
        p.address,
        p.dateOfBirth,
        p.occupation,
        p.ghanaCardNumber,
        p.licenceNumber,
        p.licenceClass,
        p.licenceExpiresOn,
        p.registrationNumber,
        p.tin,
        p.contactPerson,
        p.creditLimitMinor,
        p.paymentTermsDays,
        p.riskStatus,
        p.riskReason,
        p.riskChangedAt,
        p.source,
        p.homeBranchId,
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

  emailTaken(email: string, exceptId: string | null): Promise<boolean> {
    return this.taken("email = $1", email, exceptId);
  }

  ghanaCardTaken(number: string, exceptId: string | null): Promise<boolean> {
    return this.taken("ghana_card_number = $1", number, exceptId);
  }

  private async taken(condition: string, value: string, exceptId: string | null) {
    const { rows } = await this.tx.query(
      `select 1 from customers where ${condition} and deleted_at is null
          and ($2::uuid is null or id <> $2)`,
      [value, exceptId],
    );
    return rows.length > 0;
  }

  async list(filter: CustomerListFilter): Promise<CustomerProps[]> {
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = ["deleted_at is null"];
    if (filter.type !== undefined) where.push(`type = ${param(filter.type)}`);
    if (filter.riskStatus !== undefined) where.push(`risk_status = ${param(filter.riskStatus)}`);
    if (filter.search !== undefined && filter.search.trim() !== "") {
      const text = param(filter.search.trim().toLowerCase());
      const phone = phoneSearchKey(filter.search);
      where.push(
        `(strpos(lower(name), ${text}) > 0 or lower(code) = ${text} or email = ${text}
          or lower(ghana_card_number) = ${text}
          ${phone === null ? "" : `or strpos(phone, ${param(phone)}) > 0`})`,
      );
    }
    if (filter.after !== undefined)
      where.push(
        `(created_at, id) < (${param(filter.after.createdAt)}::timestamptz, ${param(filter.after.id)}::uuid)`,
      );
    const { rows } = await this.tx.query<CustomerRow>(
      `select ${COLUMNS} from customers where ${where.join(" and ")}
        order by created_at desc, id desc limit ${param(filter.limit)}`,
      params,
    );
    return rows.map(toProps);
  }
}
