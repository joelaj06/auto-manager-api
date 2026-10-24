import type {
  ILegalRepository,
  LegalAcceptance,
  LegalDocument,
  LegalKind,
} from "../../domain/repositories/ILegalRepository.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = {
  id: string;
  kind: LegalKind;
  version: string;
  title: string;
  body: string;
  summary: string | null;
  requires_acceptance: boolean;
  status: LegalDocument["status"];
  effective_at: Date | null;
  published_at: Date | null;
  created_by: string;
  created_at: Date;
};

const toDocument = (r: Row): LegalDocument => ({
  id: r.id,
  kind: r.kind,
  version: r.version,
  title: r.title,
  body: r.body,
  summary: r.summary,
  requiresAcceptance: r.requires_acceptance,
  status: r.status,
  effectiveAt: r.effective_at,
  publishedAt: r.published_at,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

/** The tenant accepted: by its owner in the app, or through its application at sign-up. */
const ACCEPTED_BY_TENANT = `
  (a.tenant_id = t.id
   or a.application_id in (select id from tenant_applications where tenant_id = t.id))`;

export class PostgresLegalRepository implements ILegalRepository {
  constructor(private readonly db: PlatformDb) {}

  async save(d: LegalDocument): Promise<void> {
    await this.db.query(
      `insert into legal_documents (id, kind, version, title, body, summary, requires_acceptance,
         status, effective_at, published_at, created_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (id) do update set title = excluded.title, body = excluded.body,
         summary = excluded.summary, requires_acceptance = excluded.requires_acceptance,
         status = excluded.status, effective_at = excluded.effective_at,
         published_at = excluded.published_at`,
      [
        d.id,
        d.kind,
        d.version,
        d.title,
        d.body,
        d.summary,
        d.requiresAcceptance,
        d.status,
        d.effectiveAt,
        d.publishedAt,
        d.createdBy,
        d.createdAt,
      ],
    );
  }

  async find(id: string, lock = false): Promise<LegalDocument | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<Row>(
      `select * from legal_documents where id = $1${lock ? " for update" : ""}`,
      [id],
    );
    return rows[0] === undefined ? null : toDocument(rows[0]);
  }

  async list(kind?: LegalKind): Promise<LegalDocument[]> {
    const { rows } = await this.db.query<Row>(
      `select * from legal_documents where ($1::text is null or kind = $1)
        order by kind, created_at desc`,
      [kind ?? null],
    );
    return rows.map(toDocument);
  }

  async current(kind: LegalKind, now: Date): Promise<LegalDocument | null> {
    const { rows } = await this.db.query<Row>(
      `select * from legal_documents
        where kind = $1 and status = 'published' and effective_at <= $2
        order by effective_at desc, published_at desc limit 1`,
      [kind, now],
    );
    return rows[0] === undefined ? null : toDocument(rows[0]);
  }

  async versionTaken(kind: LegalKind, version: string): Promise<boolean> {
    const { rows } = await this.db.query(
      "select 1 from legal_documents where kind = $1 and version = $2",
      [kind, version],
    );
    return rows.length > 0;
  }

  async accept(a: LegalAcceptance): Promise<void> {
    await this.db.query(
      `insert into legal_acceptances (document_id, tenant_id, application_id, tenant_user_id,
         context, accepted_at, ip, user_agent)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict do nothing`,
      [
        a.documentId,
        a.tenantId,
        a.applicationId,
        a.tenantUserId,
        a.context,
        a.acceptedAt,
        a.ip,
        a.userAgent?.slice(0, 500) ?? null,
      ],
    );
  }

  async acceptedAt(documentId: string, tenantId: string): Promise<Date | null> {
    const { rows } = await this.db.query<{ at: Date | null }>(
      `select min(a.accepted_at) as at from legal_acceptances a, tenants t
        where t.id = $2 and a.document_id = $1 and ${ACCEPTED_BY_TENANT}`,
      [documentId, tenantId],
    );
    return rows[0]?.at ?? null;
  }

  async acceptanceSummary(documentId: string) {
    const { rows } = await this.db.query<{
      tenant_id: string;
      tenant_name: string;
      accepted_at: Date;
      context: string;
    }>(
      `select distinct on (t.id) t.id as tenant_id, t.name as tenant_name, a.accepted_at, a.context
         from tenants t join legal_acceptances a on a.document_id = $1 and ${ACCEPTED_BY_TENANT}
        order by t.id, a.accepted_at`,
      [documentId],
    );
    const { rows: pending } = await this.db.query<{ n: number }>(
      `select count(*)::int as n from tenants t
        where t.status in ('trialing', 'active', 'past_due', 'read_only')
          and not exists (select 1 from legal_acceptances a
                           where a.document_id = $1 and ${ACCEPTED_BY_TENANT})`,
      [documentId],
    );
    return {
      accepted: rows.map((r) => ({
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        acceptedAt: r.accepted_at,
        context: r.context,
      })),
      pending: pending[0]!.n,
    };
  }
}
