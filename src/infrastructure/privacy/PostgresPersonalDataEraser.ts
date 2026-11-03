import { createHash } from "node:crypto";
import type pg from "pg";
import type { IObjectStorage } from "../../application/ports/IObjectStorage.js";
import type {
  ErasureReport,
  ErasureSubjectRef,
  ErasureTarget,
  IPersonalDataEraser,
  SubjectPreview,
} from "../../application/ports/IPersonalDataEraser.js";
import type { FileVisibility } from "../../domain/files/FileKinds.js";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import type { ClusterConnections } from "../database/clusters/ClusterConnections.js";
import type { Queryable } from "../database/postgres/Queryable.js";
import type { TenantDatabaseNaming } from "../database/postgres/TenantDatabaseNaming.js";

/** A short stand-in derived from the record's id: the same every time it is applied. */
export function erasureToken(id: string): string {
  return createHash("sha256").update(`erasure:${id}`).digest("hex").slice(0, 10).toUpperCase();
}

/** A phone number that reaches nobody (+999 is not a country code), unique per record. */
export function erasedPhone(id: string): string {
  const digest = createHash("sha256").update(`erasure-phone:${id}`).digest();
  return `+999${(digest.readUInt32BE(0) % 1_000_000_000).toString().padStart(9, "0")}`;
}

const erasedName = (id: string) => `Erased ${erasureToken(id)}`;
const REDACTED = "[erased]";
const ERASED_EMAIL = "erased@erased.invalid";

/**
 * Keys of audit snapshots that hold personal data; their values are replaced in the audit trail
 * of the people erased (the trail itself stays: who changed what, when).
 */
const PERSONAL_KEYS = new Set(
  [
    "name",
    "firstName",
    "lastName",
    "otherNames",
    "first_name",
    "last_name",
    "other_names",
    "phone",
    "altPhone",
    "alt_phone",
    "email",
    "address",
    "dateOfBirth",
    "date_of_birth",
    "occupation",
    "ghanaCardNumber",
    "ghana_card_number",
    "licenceNumber",
    "licence_number",
    "tin",
    "contactPerson",
    "contact_person",
    "emergencyContact",
    "emergency_contact",
    "payout",
    "notes",
    "number",
    "driverName",
    "driver_name",
    "driverPhone",
    "driver_phone",
    "customerName",
    "customer_name",
    "relationship",
  ].map((k) => k.toLowerCase()),
);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      PERSONAL_KEYS.has(k.toLowerCase()) && v !== null ? REDACTED : redact(v),
    ]),
  );
}

type Related = {
  /** Every record of the person, for the audit trail and notifications. */
  ids: string[];
  emails: string[];
};

type Work = Readonly<{
  client: pg.ClientBase;
  tables: Record<string, number>;
  related: Related;
  files: { visibility: FileVisibility; key: string }[];
}>;

/**
 * Erasure by anonymisation in a tenant's database (decision 498), as the migrator (the audit
 * trail is append-only for the app; its trigger is set aside for this transaction only).
 *
 *  - driver: the driver, their guarantors and those of their work-and-pay agreements, their
 *    identity documents, and their app account;
 *  - customer: the customer, their identity documents, and the dealer leads, quotes and test
 *    drives under their name;
 *  - user: a staff member (never the owner): signed out and disabled;
 *  - lead: a dealer lead with its quotes and test drives.
 *
 * Kept as records the business must keep (decision 498): the ledger, invoices and payments,
 * issued documents and their signatures.
 */
export class PostgresPersonalDataEraser implements IPersonalDataEraser {
  constructor(
    private readonly deps: Readonly<{
      clusters: ClusterConnections;
      naming: TenantDatabaseNaming;
      platform: Queryable;
      storage: IObjectStorage;
    }>,
  ) {}

  async preview(target: ErasureTarget, subject: ErasureSubjectRef): Promise<SubjectPreview> {
    return this.withClient(target, async (client) => {
      const found = await this.describe(client, subject);
      if (found === null)
        return { found: false, reference: null, name: null, blockedBy: null, related: {} };
      return { found: true, ...found };
    });
  }

  async erase(target: ErasureTarget, subject: ErasureSubjectRef): Promise<ErasureReport> {
    const work = await this.withClient(target, async (client) => {
      const w: Work = { client, tables: {}, related: { ids: [], emails: [] }, files: [] };
      await client.query("begin");
      try {
        const found = await this.describe(client, subject);
        if (found === null) throw new Error(`No ${subject.type} ${subject.id} in this tenant`);
        if (found.blockedBy !== null) throw new Error(found.blockedBy);
        switch (subject.type) {
          case "driver":
            await this.eraseDriver(w, subject.id);
            break;
          case "customer":
            await this.eraseCustomer(w, subject.id);
            break;
          case "user":
            await this.eraseUser(w, subject.id);
            break;
          case "lead":
            await this.eraseLeads(w, [subject.id]);
            break;
        }
        await this.eraseTraces(w);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      }
      return w;
    });

    // Identity documents leave storage once the records no longer point at them.
    for (const file of work.files) await this.deps.storage.remove(file.visibility, file.key);
    const emails = [...new Set(work.related.emails.map((e) => e.toLowerCase()))];
    const { rowCount } =
      emails.length === 0
        ? { rowCount: 0 }
        : await this.deps.platform.query(
            `update email_deliveries
                set recipient = $3, subject = null, body_text = null, body_html = null,
                    status = case when status = 'queued' then 'failed' else status end,
                    last_error = case when status = 'queued' then 'Recipient erased'
                                      else last_error end
              where tenant_id = $1 and lower(recipient) = any($2::text[])`,
            [target.tenantId, emails, ERASED_EMAIL],
          );
    return { tables: work.tables, filesRemoved: work.files.length, platformEmails: rowCount ?? 0 };
  }

  // --- subjects ---

  private async describe(
    client: pg.ClientBase,
    subject: ErasureSubjectRef,
  ): Promise<Omit<SubjectPreview, "found"> | null> {
    const one = async (sql: string) =>
      (await client.query<Record<string, unknown>>(sql, [subject.id])).rows[0];
    switch (subject.type) {
      case "driver": {
        const r = await one(
          `select code, first_name || ' ' || last_name as name,
                  (select count(*) from driver_guarantors g where g.driver_id = d.id) as guarantors,
                  (select count(*) from party_documents p
                    where p.party_type = 'driver' and p.party_id = d.id) as documents,
                  user_id
             from drivers d where id = $1`,
        );
        if (r === undefined) return null;
        return {
          reference: String(r.code),
          name: String(r.name),
          blockedBy: null,
          related: {
            guarantors: Number(r.guarantors),
            documents: Number(r.documents),
            appAccount: r.user_id === null ? 0 : 1,
          },
        };
      }
      case "customer": {
        const r = await one(
          `select code, name,
                  (select count(*) from party_documents p
                    where p.party_type = 'customer' and p.party_id = c.id) as documents,
                  (select count(*) from dealer_leads l where l.customer_id = c.id) as leads
             from customers c where id = $1`,
        );
        if (r === undefined) return null;
        return {
          reference: String(r.code),
          name: String(r.name),
          blockedBy: null,
          related: { documents: Number(r.documents), leads: Number(r.leads) },
        };
      }
      case "user": {
        const r = await one(`select name, email::text as email, is_owner from users where id = $1`);
        if (r === undefined) return null;
        return {
          reference: text(r.email),
          name: String(r.name),
          blockedBy:
            r.is_owner === true
              ? "The owner cannot be erased: transfer ownership first, or erase the business"
              : null,
          related: {},
        };
      }
      case "lead": {
        const r = await one(
          `select number, name,
                  (select count(*) from dealer_quotes q where q.lead_id = l.id) as quotes,
                  (select count(*) from dealer_test_drives t where t.lead_id = l.id) as test_drives
             from dealer_leads l where id = $1`,
        );
        if (r === undefined) return null;
        return {
          reference: String(r.number),
          name: String(r.name),
          blockedBy: null,
          related: { quotes: Number(r.quotes), testDrives: Number(r.test_drives) },
        };
      }
    }
  }

  private async eraseDriver(w: Work, id: string): Promise<void> {
    const { client } = w;
    const driver = (
      await client.query<{ email: string | null; user_id: string | null }>(
        "select email::text as email, user_id from drivers where id = $1",
        [id],
      )
    ).rows[0]!;
    this.note(w, [id], [driver.email]);
    await this.update(
      w,
      "drivers",
      `update drivers
          set first_name = 'Erased', last_name = $2, other_names = null, phone = $3,
              alt_phone = null, email = null, date_of_birth = null, gender = null,
              address = null, ghana_card_number = null, licence_number = null,
              licence_class = null, licence_issued_on = null, licence_expires_on = null,
              emergency_contact = null, payout = null, notes = null, updated_at = now()
        where id = $1`,
      [id, erasureToken(id), erasedPhone(id)],
    );

    const guarantors = await this.ids(
      client,
      "select id from driver_guarantors where driver_id = $1",
      [id],
    );
    this.note(w, guarantors);
    for (const g of guarantors)
      await this.update(
        w,
        "driver_guarantors",
        `update driver_guarantors
            set name = $2, phone = $3, address = null, occupation = null,
                ghana_card_number = null, updated_at = now()
          where id = $1`,
        [g, erasedName(g), erasedPhone(g)],
      );
    const pledges = await this.ids(
      client,
      `select g.id from workpay_guarantors g join workpay_agreements a on a.id = g.agreement_id
        where a.driver_id = $1`,
      [id],
    );
    this.note(w, pledges);
    for (const g of pledges)
      await this.update(
        w,
        "workpay_guarantors",
        `update workpay_guarantors
            set name = $2, phone = $3, address = null, ghana_card_number = null
          where id = $1`,
        [g, erasedName(g), erasedPhone(g)],
      );

    await this.eraseDocuments(w, [
      ["driver", [id]],
      ["driver_guarantor", guarantors],
    ]);
    if (driver.user_id !== null) {
      const owner = await client.query("select 1 from users where id = $1 and is_owner", [
        driver.user_id,
      ]);
      if (owner.rowCount === 0) await this.eraseUser(w, driver.user_id);
    }
  }

  private async eraseCustomer(w: Work, id: string): Promise<void> {
    const { client } = w;
    const customer = (
      await client.query<{ email: string | null }>(
        "select email::text as email from customers where id = $1",
        [id],
      )
    ).rows[0]!;
    this.note(w, [id], [customer.email]);
    // A business keeps its own name and registration; the person behind it does not.
    await this.update(
      w,
      "customers",
      `update customers
          set first_name = case when type = 'individual' then 'Erased' end,
              last_name = case when type = 'individual' then $2 end,
              name = case when type = 'individual' then $3 else company_name end,
              phone = null, alt_phone = null, email = null, address = null,
              date_of_birth = null, occupation = null, ghana_card_number = null,
              licence_number = null, licence_class = null, licence_expires_on = null,
              tin = case when type = 'individual' then null else tin end,
              contact_person = null, notes = null, updated_at = now()
        where id = $1`,
      [id, erasureToken(id), erasedName(id)],
    );
    await this.eraseDocuments(w, [["customer", [id]]]);
    const leads = await this.ids(client, "select id from dealer_leads where customer_id = $1", [
      id,
    ]);
    await this.eraseLeads(w, leads);
    await this.update(
      w,
      "dealer_quotes",
      "update dealer_quotes set customer_name = $2, updated_at = now() where customer_id = $1",
      [id, erasedName(id)],
    );
  }

  private async eraseUser(w: Work, id: string): Promise<void> {
    const { client } = w;
    const user = (
      await client.query<{ email: string | null }>(
        "select email::text as email from users where id = $1",
        [id],
      )
    ).rows[0]!;
    this.note(w, [id], [user.email]);
    await this.update(
      w,
      "users",
      `update users
          set name = $2, email = null, phone = $3, status = 'disabled', password_hash = null,
              permission_version = permission_version + 1, updated_at = now()
        where id = $1`,
      [id, erasedName(id), erasedPhone(id)],
    );
    await this.update(
      w,
      "auth_sessions",
      `update auth_sessions
          set revoked_at = coalesce(revoked_at, now()),
              revocation_reason = coalesce(revocation_reason, 'user_disabled'),
              ip = null, user_agent = null
        where user_id = $1`,
      [id],
    );
    // What the person did stays in the trail, without where they did it from.
    await this.update(
      w,
      "audit_logs",
      `update audit_logs set ip = null, user_agent = null
        where actor_type = 'user' and actor_id = $1 and (ip is not null or user_agent is not null)`,
      [id],
    );
  }

  private async eraseLeads(w: Work, leads: readonly string[]): Promise<void> {
    const { client } = w;
    for (const id of leads) {
      const lead = (
        await client.query<{ email: string | null }>(
          "select email::text as email from dealer_leads where id = $1",
          [id],
        )
      ).rows[0]!;
      this.note(w, [id], [lead.email]);
      await this.update(
        w,
        "dealer_leads",
        `update dealer_leads set name = $2, phone = null, email = null, notes = null,
                updated_at = now()
          where id = $1`,
        [id, erasedName(id)],
      );
      await this.update(
        w,
        "dealer_quotes",
        "update dealer_quotes set customer_name = $2, updated_at = now() where lead_id = $1",
        [id, erasedName(id)],
      );
      const drives = await this.ids(
        client,
        "select id from dealer_test_drives where lead_id = $1",
        [id],
      );
      this.note(w, drives);
      for (const d of drives)
        await this.update(
          w,
          "dealer_test_drives",
          `update dealer_test_drives
              set driver_name = $2, driver_phone = $3, licence_number = 'ERASED', notes = null,
                  feedback = null, updated_at = now()
            where id = $1`,
          [d, erasedName(d), erasedPhone(d)],
        );
    }
  }

  /** Identity documents: their numbers and notes go, their files leave storage. */
  private async eraseDocuments(
    w: Work,
    parties: readonly (readonly [string, readonly string[]])[],
  ): Promise<void> {
    const { client } = w;
    for (const [type, ids] of parties) {
      if (ids.length === 0) continue;
      const documents = await this.ids(
        client,
        "select id from party_documents where party_type = $1 and party_id = any($2::uuid[])",
        [type, ids],
      );
      if (documents.length === 0) continue;
      this.note(w, documents);
      await this.update(
        w,
        "party_documents",
        `update party_documents set number = null, notes = null, updated_at = now()
          where id = any($1::uuid[])`,
        [documents],
      );
      const { rows } = await client.query<{ visibility: FileVisibility; storage_key: string }>(
        `update files set status = 'deleted', deleted_at = now(), filename = 'erased'
          where owner_type = 'party_document' and owner_id = any($1::uuid[])
            and status <> 'deleted'
          returning visibility, storage_key`,
        [documents],
      );
      if (rows.length > 0) w.tables.files = (w.tables.files ?? 0) + rows.length;
      w.files.push(...rows.map((r) => ({ visibility: r.visibility, key: r.storage_key })));
    }
  }

  /** The copies of the person's data in notifications sent and in the audit trail. */
  private async eraseTraces(w: Work): Promise<void> {
    const { client, related } = w;
    if (related.ids.length === 0) return;
    await this.update(
      w,
      "notification_deliveries",
      `update notification_deliveries
          set address = $2, title = case when title is null then null else $2 end, body = $2,
              data = '{}'::jsonb
        where recipient_id = any($1::uuid[]) and address <> $2`,
      [related.ids, REDACTED],
    );
    const { rows } = await client.query<{ id: string; before: unknown; after: unknown }>(
      `select id, before, after from audit_logs
        where entity_id = any($1::text[]) and (before is not null or after is not null)`,
      [related.ids],
    );
    const changed = rows
      .map((r) => ({ id: r.id, before: redact(r.before), after: redact(r.after), was: r }))
      .filter(
        (r) =>
          JSON.stringify(r.before) !== JSON.stringify(r.was.before) ||
          JSON.stringify(r.after) !== JSON.stringify(r.was.after),
      );
    if (changed.length === 0) return;
    // The trail is append-only for the app; only its owner may lift that, for this transaction.
    await client.query("alter table audit_logs disable trigger audit_logs_append_only");
    for (const r of changed)
      await client.query("update audit_logs set before = $2, after = $3 where id = $1", [
        r.id,
        r.before === null ? null : JSON.stringify(r.before),
        r.after === null ? null : JSON.stringify(r.after),
      ]);
    await client.query("alter table audit_logs enable trigger audit_logs_append_only");
    w.tables.audit_logs = (w.tables.audit_logs ?? 0) + changed.length;
  }

  // --- helpers ---

  private note(w: Work, ids: readonly string[], emails: readonly (string | null)[] = []): void {
    w.related.ids.push(...ids);
    w.related.emails.push(...emails.filter((e): e is string => e !== null));
  }

  private async update(w: Work, table: string, sql: string, params: unknown[]): Promise<void> {
    const { rowCount } = await w.client.query(sql, params);
    if ((rowCount ?? 0) > 0) w.tables[table] = (w.tables[table] ?? 0) + (rowCount ?? 0);
  }

  private async ids(client: pg.ClientBase, sql: string, params: unknown[]): Promise<string[]> {
    const { rows } = await client.query<{ id: string }>(sql, params);
    return rows.map((r) => r.id);
  }

  private async withClient<T>(
    target: ErasureTarget,
    work: (client: pg.ClientBase) => Promise<T>,
  ): Promise<T> {
    const { clusters, naming } = this.deps;
    const tenantId = TenantId.from(target.tenantId);
    const connections =
      target.database === undefined
        ? await clusters.ofTenant(tenantId.value)
        : await clusters.on(target.database.clusterId);
    const client = await connections.connect(
      "migrator",
      target.database?.name ?? naming.databaseNameFor(tenantId),
    );
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }
}

const text = (v: unknown) => (typeof v === "string" ? v : null);
