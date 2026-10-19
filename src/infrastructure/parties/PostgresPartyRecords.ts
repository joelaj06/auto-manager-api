import type {
  Guarantor,
  IDriverGuarantors,
  IDriverSettingsStore,
  IPartyDocuments,
  IPartyStatusHistory,
  ISupplierQueries,
  PartyDocument,
  PartyStatusEntry,
  PartyType,
  SupplierListFilter,
} from "../../application/ports/IPartyRecords.js";
import { DEFAULT_DRIVER_RULES, type DriverOnboardingRules } from "../../domain/parties/Driver.js";
import { Supplier, type SupplierProps } from "../../domain/parties/Supplier.js";
import type { ISupplierRepository } from "../../domain/repositories/IPartyRepositories.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";
import { phoneSearchKey, UUID } from "./partySql.js";

type SupplierRow = {
  id: string;
  code: string;
  name: string;
  type: SupplierProps["type"];
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  tin: string | null;
  payment_terms_days: number | null;
  payout: SupplierProps["payout"];
  active: boolean;
  tags: string[];
  notes: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  deleted_reason: string | null;
};
const SUPPLIER_COLUMNS = `id, code, name, type, contact_person, phone, email::text as email,
  address, tin, payment_terms_days, payout, active, tags, notes, created_by, created_at,
  updated_at, deleted_at, deleted_reason`;
const toSupplier = (r: SupplierRow): SupplierProps => ({
  id: r.id,
  code: r.code,
  name: r.name,
  type: r.type,
  contactPerson: r.contact_person,
  phone: r.phone,
  email: r.email,
  address: r.address,
  tin: r.tin,
  paymentTermsDays: r.payment_terms_days,
  payout: r.payout,
  active: r.active,
  tags: r.tags,
  notes: r.notes,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
  deletedReason: r.deleted_reason,
});

/** Suppliers in the tenant database (tenant unit of work). */
export class PostgresSupplierRepository implements ISupplierRepository, ISupplierQueries {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async findById(id: string): Promise<Supplier | null> {
    return this.one(id, "");
  }

  async lockById(id: string): Promise<Supplier | null> {
    return this.one(id, "for update");
  }

  private async one(id: string, lock: string): Promise<Supplier | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<SupplierRow>(
      `select ${SUPPLIER_COLUMNS} from suppliers where id = $1 and deleted_at is null ${lock}`,
      [id],
    );
    return rows[0] === undefined ? null : Supplier.restore(toSupplier(rows[0]));
  }

  async save(supplier: Supplier): Promise<void> {
    const p = supplier.snapshot();
    await this.tx.query(
      `insert into suppliers (id, code, name, type, contact_person, phone, email, address, tin,
         payment_terms_days, payout, active, tags, notes, created_by, created_at, updated_at,
         deleted_at, deleted_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       on conflict (id) do update set name = excluded.name, type = excluded.type,
         contact_person = excluded.contact_person, phone = excluded.phone,
         email = excluded.email, address = excluded.address, tin = excluded.tin,
         payment_terms_days = excluded.payment_terms_days, payout = excluded.payout,
         active = excluded.active, tags = excluded.tags, notes = excluded.notes,
         updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
         deleted_reason = excluded.deleted_reason`,
      [
        p.id,
        p.code,
        p.name,
        p.type,
        p.contactPerson,
        p.phone,
        p.email,
        p.address,
        p.tin,
        p.paymentTermsDays,
        p.payout === null ? null : JSON.stringify(p.payout),
        p.active,
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

  async nameTaken(name: string, exceptId: string | null): Promise<boolean> {
    const { rows } = await this.tx.query(
      `select 1 from suppliers where lower(name) = lower($1) and deleted_at is null
          and ($2::uuid is null or id <> $2)`,
      [name, exceptId],
    );
    return rows.length > 0;
  }

  async list(filter: SupplierListFilter): Promise<SupplierProps[]> {
    const search = filter.search?.trim().toLowerCase() ?? null;
    const phone = filter.search === undefined ? null : phoneSearchKey(filter.search);
    const { rows } = await this.tx.query<SupplierRow>(
      `select ${SUPPLIER_COLUMNS} from suppliers
        where deleted_at is null and ($1::boolean or active)
          and ($2::text is null or type = $2)
          and ($3::text is null or strpos(lower(name), $3) > 0 or lower(code) = $3
               or ($4::text is not null and strpos(phone, $4) > 0))
        order by lower(name)
        limit 1000`,
      [filter.includeInactive === true, filter.type ?? null, search === "" ? null : search, phone],
    );
    return rows.map(toSupplier);
  }
}

type GuarantorRow = {
  id: string;
  driver_id: string;
  name: string;
  phone: string;
  relationship: string | null;
  address: string | null;
  occupation: string | null;
  ghana_card_number: string | null;
  created_at: Date;
  updated_at: Date;
};
const toGuarantor = (r: GuarantorRow): Guarantor => ({
  id: r.id,
  driverId: r.driver_id,
  name: r.name,
  phone: r.phone,
  relationship: r.relationship,
  address: r.address,
  occupation: r.occupation,
  ghanaCardNumber: r.ghana_card_number,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Drivers' guarantors in the tenant database. */
export class PostgresDriverGuarantors implements IDriverGuarantors {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async list(driverId: string): Promise<Guarantor[]> {
    const { rows } = await this.tx.query<GuarantorRow>(
      "select * from driver_guarantors where driver_id = $1 order by created_at",
      [driverId],
    );
    return rows.map(toGuarantor);
  }

  async get(id: string): Promise<Guarantor | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<GuarantorRow>(
      "select * from driver_guarantors where id = $1",
      [id],
    );
    return rows[0] === undefined ? null : toGuarantor(rows[0]);
  }

  async save(g: Guarantor): Promise<void> {
    await this.tx.query(
      `insert into driver_guarantors (id, driver_id, name, phone, relationship, address,
         occupation, ghana_card_number, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (id) do update set name = excluded.name, phone = excluded.phone,
         relationship = excluded.relationship, address = excluded.address,
         occupation = excluded.occupation, ghana_card_number = excluded.ghana_card_number,
         updated_at = excluded.updated_at`,
      [
        g.id,
        g.driverId,
        g.name,
        g.phone,
        g.relationship,
        g.address,
        g.occupation,
        g.ghanaCardNumber,
        g.createdAt,
        g.updatedAt,
      ],
    );
  }

  async remove(id: string): Promise<void> {
    await this.tx.query("delete from driver_guarantors where id = $1", [id]);
  }
}

type DocumentRow = {
  id: string;
  party_type: PartyType;
  party_id: string;
  type: PartyDocument["type"];
  number: string | null;
  issued_on: string | null;
  expires_on: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};
const DOCUMENT_COLUMNS = `id, party_type, party_id, type, number, issued_on::text as issued_on,
  expires_on::text as expires_on, notes, created_by, created_at, updated_at`;
const toDocument = (r: DocumentRow): PartyDocument => ({
  id: r.id,
  partyType: r.party_type,
  partyId: r.party_id,
  type: r.type,
  number: r.number,
  issuedOn: r.issued_on,
  expiresOn: r.expires_on,
  notes: r.notes,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Party documents in the tenant database. */
export class PostgresPartyDocuments implements IPartyDocuments {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async list(partyType: PartyType, partyId: string): Promise<PartyDocument[]> {
    const { rows } = await this.tx.query<DocumentRow>(
      `select ${DOCUMENT_COLUMNS} from party_documents where party_type = $1 and party_id = $2
        order by type, created_at desc`,
      [partyType, partyId],
    );
    return rows.map(toDocument);
  }

  async get(id: string): Promise<PartyDocument | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<DocumentRow>(
      `select ${DOCUMENT_COLUMNS} from party_documents where id = $1`,
      [id],
    );
    return rows[0] === undefined ? null : toDocument(rows[0]);
  }

  async save(d: PartyDocument): Promise<void> {
    await this.tx.query(
      `insert into party_documents (id, party_type, party_id, type, number, issued_on,
         expires_on, notes, created_by, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (id) do update set type = excluded.type, number = excluded.number,
         issued_on = excluded.issued_on, expires_on = excluded.expires_on,
         notes = excluded.notes, updated_at = excluded.updated_at`,
      [
        d.id,
        d.partyType,
        d.partyId,
        d.type,
        d.number,
        d.issuedOn,
        d.expiresOn,
        d.notes,
        d.createdBy,
        d.createdAt,
        d.updatedAt,
      ],
    );
  }

  async remove(id: string): Promise<void> {
    await this.tx.query("delete from party_documents where id = $1", [id]);
  }
}

/** Driver status and customer risk history in the tenant database. */
export class PostgresPartyStatusHistory implements IPartyStatusHistory {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async record(entry: Parameters<IPartyStatusHistory["record"]>[0]): Promise<void> {
    await this.transactions.current().query(
      `insert into party_status_history (party_type, party_id, from_status, to_status, reason,
           changed_by, changed_at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.partyType,
        entry.partyId,
        entry.from,
        entry.to,
        entry.reason,
        entry.changedBy,
        entry.at,
      ],
    );
  }

  async list(partyType: "driver" | "customer", partyId: string): Promise<PartyStatusEntry[]> {
    const { rows } = await this.transactions.current().query<{
      id: string;
      from_status: string | null;
      to_status: string;
      reason: string | null;
      changed_by: string | null;
      changed_at: Date;
    }>(
      `select id, from_status, to_status, reason, changed_by, changed_at
         from party_status_history where party_type = $1 and party_id = $2
        order by changed_at desc, id desc`,
      [partyType, partyId],
    );
    return rows.map((r) => ({
      id: r.id,
      from: r.from_status,
      to: r.to_status,
      reason: r.reason,
      changedBy: r.changed_by,
      changedAt: r.changed_at,
    }));
  }
}

/** Driver onboarding rules in `organisation.settings->'drivers'`, over the defaults. */
export class PostgresDriverSettingsStore implements IDriverSettingsStore {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async get(): Promise<DriverOnboardingRules> {
    const { rows } = await this.transactions
      .current()
      .query<{ drivers: Partial<DriverOnboardingRules> | null }>(
        "select settings->'drivers' as drivers from organisation",
      );
    return { ...DEFAULT_DRIVER_RULES, ...(rows[0]?.drivers ?? {}) };
  }

  async set(rules: DriverOnboardingRules): Promise<void> {
    await this.transactions
      .current()
      .query(
        "update organisation set settings = jsonb_set(settings, '{drivers}', $1::jsonb), updated_at = now()",
        [JSON.stringify(rules)],
      );
  }
}
