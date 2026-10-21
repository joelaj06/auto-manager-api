import type {
  DocumentEvent,
  DocumentListFilter,
  IDocumentEvents,
  IDocumentRepository,
  IDocumentTemplateRepository,
} from "../../application/ports/IDocumentRecords.js";
import {
  DocumentTemplate,
  type DocumentTemplateProps,
} from "../../domain/documents/DocumentTemplate.js";
import type { DocumentType, Language } from "../../domain/documents/DocumentTypes.js";
import { IssuedDocument, type IssuedDocumentProps } from "../../domain/documents/IssuedDocument.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

type TemplateRow = {
  id: string;
  type: DocumentType;
  language: Language;
  name: string;
  version: number;
  body: string;
  status: DocumentTemplateProps["status"];
  system_version: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  activated_by: string | null;
  activated_at: Date | null;
  archived_at: Date | null;
};

const toTemplate = (r: TemplateRow) =>
  DocumentTemplate.restore({
    id: r.id,
    type: r.type,
    language: r.language,
    name: r.name,
    version: r.version,
    body: r.body,
    status: r.status,
    systemVersion: r.system_version,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    activatedBy: r.activated_by,
    activatedAt: r.activated_at,
    archivedAt: r.archived_at,
  });

export class PostgresDocumentTemplates implements IDocumentTemplateRepository {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async findById(id: string) {
    const { rows } = await this.tx.query<TemplateRow>(
      "select * from document_templates where id = $1",
      [id],
    );
    return rows[0] === undefined ? null : toTemplate(rows[0]);
  }

  async lockById(id: string) {
    const { rows } = await this.tx.query<TemplateRow>(
      "select * from document_templates where id = $1 for update",
      [id],
    );
    return rows[0] === undefined ? null : toTemplate(rows[0]);
  }

  async save(template: DocumentTemplate): Promise<void> {
    const p = template.snapshot();
    await this.tx.query(
      `insert into document_templates (id, type, language, name, version, body, status,
         system_version, created_by, created_at, updated_at, activated_by, activated_at, archived_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (id) do update set name = excluded.name, body = excluded.body,
         status = excluded.status, system_version = excluded.system_version,
         updated_at = excluded.updated_at, activated_by = excluded.activated_by,
         activated_at = excluded.activated_at, archived_at = excluded.archived_at`,
      [
        p.id,
        p.type,
        p.language,
        p.name,
        p.version,
        p.body,
        p.status,
        p.systemVersion,
        p.createdBy,
        p.createdAt,
        p.updatedAt,
        p.activatedBy,
        p.activatedAt,
        p.archivedAt,
      ],
    );
  }

  async delete(id: string): Promise<void> {
    await this.tx.query("delete from document_templates where id = $1 and status = 'draft'", [id]);
  }

  async list(filter: Readonly<{ type?: DocumentType; language?: Language }>) {
    const { rows } = await this.tx.query<TemplateRow>(
      `select * from document_templates
        where ($1::text is null or type = $1) and ($2::text is null or language = $2)
        order by type, language, version desc`,
      [filter.type ?? null, filter.language ?? null],
    );
    return rows.map(toTemplate);
  }

  async active(type: DocumentType, language: Language) {
    const { rows } = await this.tx.query<TemplateRow>(
      "select * from document_templates where type = $1 and language = $2 and status = 'active'",
      [type, language],
    );
    return rows[0] === undefined ? null : toTemplate(rows[0]);
  }

  async lockType(type: DocumentType, language: Language): Promise<void> {
    await this.tx.query("select pg_advisory_xact_lock(hashtext('document_templates:' || $1))", [
      `${type}:${language}`,
    ]);
  }

  async nextVersion(type: DocumentType, language: Language): Promise<number> {
    const { rows } = await this.tx.query<{ next: number }>(
      `select coalesce(max(version), 0) + 1 as next from document_templates
        where type = $1 and language = $2`,
      [type, language],
    );
    return Number(rows[0]!.next);
  }
}

type DocumentRow = {
  id: string;
  number: string;
  type: IssuedDocumentProps["type"];
  language: IssuedDocumentProps["language"];
  template_id: string | null;
  template_version: string;
  template_body: string;
  subject_type: string;
  subject_id: string;
  branch_id: string | null;
  data_snapshot: Record<string, unknown>;
  verification_code: string;
  status: IssuedDocumentProps["status"];
  pdf_file_id: string | null;
  pdf_sha256: string | null;
  rendered_at: Date | null;
  issued_by: string | null;
  issued_at: Date;
  voided_by: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  replaces_id: string | null;
};

const toDocument = (r: DocumentRow) =>
  IssuedDocument.restore({
    id: r.id,
    number: r.number,
    type: r.type,
    language: r.language,
    templateId: r.template_id,
    templateVersion: r.template_version,
    templateBody: r.template_body,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    branchId: r.branch_id,
    data: r.data_snapshot,
    verificationCode: r.verification_code,
    status: r.status,
    pdfFileId: r.pdf_file_id,
    pdfSha256: r.pdf_sha256,
    renderedAt: r.rendered_at,
    issuedBy: r.issued_by,
    issuedAt: r.issued_at,
    voidedBy: r.voided_by,
    voidedAt: r.voided_at,
    voidReason: r.void_reason,
    replacesId: r.replaces_id,
  });

export class PostgresIssuedDocuments implements IDocumentRepository {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  private async one(sql: string, params: unknown[]) {
    const { rows } = await this.tx.query<DocumentRow>(sql, params);
    return rows[0] === undefined ? null : toDocument(rows[0]);
  }

  findById(id: string) {
    return this.one("select * from documents where id = $1", [id]);
  }

  lockById(id: string) {
    return this.one("select * from documents where id = $1 for update", [id]);
  }

  findByCode(code: string) {
    return this.one("select * from documents where verification_code = $1", [code]);
  }

  async save(document: IssuedDocument): Promise<void> {
    const p = document.snapshot();
    await this.tx.query(
      `insert into documents (id, number, type, language, template_id, template_version,
         template_body, subject_type, subject_id, branch_id, data_snapshot, verification_code,
         status, pdf_file_id, pdf_sha256, rendered_at, issued_by, issued_at, voided_by, voided_at,
         void_reason, replaces_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19, $20, $21, $22)
       on conflict (id) do update set status = excluded.status, pdf_file_id = excluded.pdf_file_id,
         pdf_sha256 = excluded.pdf_sha256, rendered_at = excluded.rendered_at,
         voided_by = excluded.voided_by, voided_at = excluded.voided_at,
         void_reason = excluded.void_reason`,
      [
        p.id,
        p.number,
        p.type,
        p.language,
        p.templateId,
        p.templateVersion,
        p.templateBody,
        p.subjectType,
        p.subjectId,
        p.branchId,
        JSON.stringify(p.data),
        p.verificationCode,
        p.status,
        p.pdfFileId,
        p.pdfSha256,
        p.renderedAt,
        p.issuedBy,
        p.issuedAt,
        p.voidedBy,
        p.voidedAt,
        p.voidReason,
        p.replacesId,
      ],
    );
  }

  async list(filter: DocumentListFilter): Promise<IssuedDocument[]> {
    const { rows } = await this.tx.query<DocumentRow>(
      `select * from documents
        where ($1::uuid[] is null or branch_id = any($1::uuid[]) or branch_id is null)
          and ($2::uuid is null or branch_id = $2)
          and ($3::text is null or type = $3)
          and ($4::text is null or (subject_type = $4 and subject_id = $5::uuid))
          and ($6::text is null or status = $6)
          and ($7::uuid is null or id < $7)
        order by id desc
        limit $8`,
      [
        filter.branchIds === "all" ? null : filter.branchIds,
        filter.branchId ?? null,
        filter.type ?? null,
        filter.subject?.type ?? null,
        filter.subject?.id ?? null,
        filter.status ?? null,
        filter.afterId ?? null,
        filter.limit,
      ],
    );
    return rows.map(toDocument);
  }

  async unrendered(limit: number): Promise<string[]> {
    const { rows } = await this.tx.query<{ id: string }>(
      "select id from documents where pdf_file_id is null order by id limit $1",
      [limit],
    );
    return rows.map((r) => r.id);
  }
}

export class PostgresDocumentEvents implements IDocumentEvents {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async add(event: Parameters<IDocumentEvents["add"]>[0]): Promise<void> {
    await this.transactions.current().query(
      `insert into document_events (document_id, type, actor_type, actor_id, ip, metadata, at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        event.documentId,
        event.type,
        event.actorType,
        event.actorId,
        event.ip,
        JSON.stringify(event.metadata),
        event.at,
      ],
    );
  }

  async list(documentId: string): Promise<DocumentEvent[]> {
    const { rows } = await this.transactions.current().query<{
      id: string;
      document_id: string;
      type: DocumentEvent["type"];
      actor_type: DocumentEvent["actorType"];
      actor_id: string | null;
      ip: string | null;
      metadata: Record<string, unknown>;
      at: Date;
    }>("select * from document_events where document_id = $1 order by id", [documentId]);
    return rows.map((r) => ({
      id: r.id,
      documentId: r.document_id,
      type: r.type,
      actorType: r.actor_type,
      actorId: r.actor_id,
      ip: r.ip,
      metadata: r.metadata,
      at: r.at,
    }));
  }
}
