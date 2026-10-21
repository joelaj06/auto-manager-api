import {
  DEFAULT_DOCUMENT_SETTINGS,
  type DocumentSettings,
  type IDocumentSettingsStore,
  type IDocumentSigners,
  type IDocumentSigningLinks,
  type ISignerParties,
} from "../../application/ports/IDocumentRecords.js";
import { DocumentSigner, type DocumentSignerProps } from "../../domain/documents/DocumentSigner.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

type Row = {
  id: string;
  document_id: string;
  position: number;
  role: string;
  label: string;
  party_type: DocumentSignerProps["partyType"];
  party_id: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  required: boolean;
  status: DocumentSignerProps["status"];
  method: DocumentSignerProps["method"];
  signature_file_id: string | null;
  typed_name: string | null;
  paper_file_id: string | null;
  verified_by: string | null;
  consent_text: string | null;
  document_sha256: string | null;
  otp_sent_at: Date | null;
  otp_verified_at: Date | null;
  otp_channel: DocumentSignerProps["otpChannel"];
  signed_at: Date | null;
  ip: string | null;
  user_agent: string | null;
  declined_at: Date | null;
  decline_reason: string | null;
  last_reminded_at: Date | null;
  reminders: number;
  created_at: Date;
};

const toSigner = (r: Row) =>
  DocumentSigner.restore({
    id: r.id,
    documentId: r.document_id,
    position: r.position,
    role: r.role,
    label: r.label,
    partyType: r.party_type,
    partyId: r.party_id,
    name: r.name,
    phone: r.phone,
    email: r.email,
    required: r.required,
    status: r.status,
    method: r.method,
    signatureFileId: r.signature_file_id,
    typedName: r.typed_name,
    paperFileId: r.paper_file_id,
    verifiedBy: r.verified_by,
    consentText: r.consent_text,
    documentSha256: r.document_sha256,
    otpSentAt: r.otp_sent_at,
    otpVerifiedAt: r.otp_verified_at,
    otpChannel: r.otp_channel,
    signedAt: r.signed_at,
    ip: r.ip,
    userAgent: r.user_agent,
    declinedAt: r.declined_at,
    declineReason: r.decline_reason,
    lastRemindedAt: r.last_reminded_at,
    reminders: r.reminders,
    createdAt: r.created_at,
  });

const COLUMNS = [
  "id",
  "document_id",
  "position",
  "role",
  "label",
  "party_type",
  "party_id",
  "name",
  "phone",
  "email",
  "required",
  "status",
  "method",
  "signature_file_id",
  "typed_name",
  "paper_file_id",
  "verified_by",
  "consent_text",
  "document_sha256",
  "otp_sent_at",
  "otp_verified_at",
  "otp_channel",
  "signed_at",
  "ip",
  "user_agent",
  "declined_at",
  "decline_reason",
  "last_reminded_at",
  "reminders",
  "created_at",
] as const;
const MUTABLE = COLUMNS.slice(11).filter((c) => c !== "created_at");

export class PostgresDocumentSigners implements IDocumentSigners {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async findById(id: string) {
    const { rows } = await this.tx.query<Row>("select * from document_signers where id = $1", [id]);
    return rows[0] === undefined ? null : toSigner(rows[0]);
  }

  async lockById(id: string) {
    const { rows } = await this.tx.query<Row>(
      "select * from document_signers where id = $1 for update",
      [id],
    );
    return rows[0] === undefined ? null : toSigner(rows[0]);
  }

  async save(signer: DocumentSigner): Promise<void> {
    const p = signer.snapshot();
    const values = [
      p.id,
      p.documentId,
      p.position,
      p.role,
      p.label,
      p.partyType,
      p.partyId,
      p.name,
      p.phone,
      p.email,
      p.required,
      p.status,
      p.method,
      p.signatureFileId,
      p.typedName,
      p.paperFileId,
      p.verifiedBy,
      p.consentText,
      p.documentSha256,
      p.otpSentAt,
      p.otpVerifiedAt,
      p.otpChannel,
      p.signedAt,
      p.ip,
      p.userAgent,
      p.declinedAt,
      p.declineReason,
      p.lastRemindedAt,
      p.reminders,
      p.createdAt,
    ];
    await this.tx.query(
      `insert into document_signers (${COLUMNS.join(", ")})
       values (${COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})
       on conflict (id) do update set ${MUTABLE.map((c) => `${c} = excluded.${c}`).join(", ")}`,
      values,
    );
  }

  async listFor(documentId: string) {
    const { rows } = await this.tx.query<Row>(
      "select * from document_signers where document_id = $1 order by position",
      [documentId],
    );
    return rows.map(toSigner);
  }

  async pendingFor(parties: readonly Readonly<{ type: "user" | "driver"; id: string }>[]) {
    if (parties.length === 0) return [];
    const { rows } = await this.tx.query<Row>(
      `select s.* from document_signers s
         join documents d on d.id = s.document_id
        where s.status = 'pending' and d.status in ('pending_signatures', 'partially_signed')
          and (s.party_type, s.party_id) in
              (select * from unnest($1::text[], $2::uuid[]))
        order by s.id desc`,
      [parties.map((p) => p.type), parties.map((p) => p.id)],
    );
    return rows.map(toSigner);
  }

  async remindable(before: Date, max: number, limit: number) {
    const { rows } = await this.tx.query<Row>(
      `select s.* from document_signers s
         join documents d on d.id = s.document_id
        where s.status = 'pending' and d.status in ('pending_signatures', 'partially_signed')
          and coalesce(s.last_reminded_at, s.created_at) < $1 and s.reminders < $2
        order by s.id
        limit $3`,
      [before, max, limit],
    );
    return rows.map(toSigner);
  }
}

export class PostgresDocumentSigningLinks implements IDocumentSigningLinks {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async create(link: Parameters<IDocumentSigningLinks["create"]>[0]): Promise<void> {
    await this.tx.query(
      `insert into document_signing_links (signer_id, token_hash, created_by, expires_at)
       values ($1, $2, $3, $4)`,
      [link.signerId, link.tokenHash, link.createdBy, link.expiresAt],
    );
  }

  async lockValid(tokenHash: string, now: Date) {
    const { rows } = await this.tx.query<{ id: string; signer_id: string; expires_at: Date }>(
      `select id, signer_id, expires_at from document_signing_links
        where token_hash = $1 and used_at is null and revoked_at is null and expires_at > $2
        for update`,
      [tokenHash, now],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { id: row.id, signerId: row.signer_id, expiresAt: row.expires_at };
  }

  async markUsed(id: string, now: Date): Promise<void> {
    await this.tx.query("update document_signing_links set used_at = $2 where id = $1", [id, now]);
  }

  async revokeOpen(signerId: string, now: Date): Promise<void> {
    await this.tx.query(
      `update document_signing_links set revoked_at = $2
        where signer_id = $1 and used_at is null and revoked_at is null`,
      [signerId, now],
    );
  }
}

/** Document settings in `organisation.settings->'documents'`, over the defaults. */
export class PostgresDocumentSettingsStore implements IDocumentSettingsStore {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async get(): Promise<DocumentSettings> {
    const { rows } = await this.transactions
      .current()
      .query<{ documents: Partial<DocumentSettings> | null }>(
        "select settings->'documents' as documents from organisation",
      );
    return { ...DEFAULT_DOCUMENT_SETTINGS, ...(rows[0]?.documents ?? {}) };
  }

  async set(settings: DocumentSettings): Promise<void> {
    await this.transactions
      .current()
      .query(
        "update organisation set settings = jsonb_set(settings, '{documents}', $1::jsonb), updated_at = now()",
        [JSON.stringify(settings)],
      );
  }
}

export class PostgresSignerParties implements ISignerParties {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async user(id: string) {
    const { rows } = await this.transactions.current().query<{
      name: string;
      phone: string | null;
      email: string | null;
    }>("select name, phone, email::text as email from users where id = $1 and status <> 'disabled'", [id]);
    return rows[0] ?? null;
  }

  async driver(id: string) {
    const { rows } = await this.transactions.current().query<{
      name: string;
      phone: string | null;
      email: string | null;
    }>(
      `select first_name || ' ' || last_name as name, phone, email::text as email
         from drivers where id = $1 and deleted_at is null`,
      [id],
    );
    return rows[0] ?? null;
  }
}
