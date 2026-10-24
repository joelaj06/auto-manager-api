import type { IObjectStorage } from "../../application/ports/IObjectStorage.js";
import type { ITenantDataArchiver } from "../../application/ports/ITenantDataArchiver.js";
import type { FileVisibility } from "../../domain/files/FileKinds.js";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import type { TenantConnectionPools } from "../database/postgres/TenantConnectionPools.js";
import { ZipWriter } from "./ZipWriter.js";

/** Plumbing, not the business's data: queues, sessions, one-time codes and links, counters. */
const INTERNAL_TABLES = new Set([
  "processed_messages",
  "outbox",
  "counters",
  "auth_sessions",
  "otp_challenges",
  "user_invitations",
  "stats_dirty_marks",
  "document_signing_links",
  "push_devices",
  "notification_deliveries",
  "tenant_info",
  "schema_migrations",
]);
/** Never exported: passwords, token hashes, sealed credentials. */
const SECRET_COLUMN = /(password|token|secret|sealed|_hash$|hash$|credential|api_key)/i;
/** File contents beyond this total are listed in the manifest only. */
const FILE_BUDGET_BYTES = 200 * 1024 * 1024;
const ROW_BATCH = 5_000;

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s =
    v instanceof Date
      ? v.toISOString()
      : typeof v === "string" ||
          typeof v === "number" ||
          typeof v === "boolean" ||
          typeof v === "bigint"
        ? String(v)
        : JSON.stringify(v);
  const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * "Export all my data": every business table of the tenant database as CSV (secrets and
 * plumbing left out), the files people uploaded (within a size budget; the rest listed), and a
 * README describing what is where. Read in one read-only transaction, so the export is
 * consistent.
 */
export class PostgresTenantDataArchiver implements ITenantDataArchiver {
  constructor(
    private readonly pools: TenantConnectionPools,
    private readonly storage: IObjectStorage,
  ) {}

  async build(tenantId: string, options: Readonly<{ businessName: string; generatedAt: Date }>) {
    const zip = new ZipWriter();
    const { tables, files } = await this.pools.withTransaction(
      TenantId.from(tenantId),
      async (tx) => {
        const { rows: tableRows } = await tx.query<{ table_name: string }>(
          `select table_name from information_schema.tables
            where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
        );
        const exported: { name: string; rows: number; columns: string[] }[] = [];
        for (const { table_name: table } of tableRows) {
          if (INTERNAL_TABLES.has(table)) continue;
          const { rows: columnRows } = await tx.query<{ column_name: string }>(
            `select column_name from information_schema.columns
              where table_schema = 'public' and table_name = $1 order by ordinal_position`,
            [table],
          );
          const columns = columnRows
            .map((c) => c.column_name)
            .filter((c) => !SECRET_COLUMN.test(c));
          const lines = [columns.join(",")];
          let count = 0;
          for (let offset = 0; ; offset += ROW_BATCH) {
            const { rows } = await tx.query<Record<string, unknown>>(
              `select ${columns.map(quoteIdent).join(", ")} from ${quoteIdent(table)}
                order by 1 limit ${ROW_BATCH} offset ${offset}`,
            );
            for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(","));
            count += rows.length;
            if (rows.length < ROW_BATCH) break;
          }
          zip.add(`tables/${table}.csv`, Buffer.from(`${lines.join("\n")}\n`, "utf8"));
          exported.push({ name: table, rows: count, columns });
        }
        const { rows: fileRows } = await tx.query<{
          id: string;
          kind: string;
          storage_key: string;
          visibility: FileVisibility;
          filename: string;
          content_type: string;
          size_bytes: string;
          created_at: Date;
        }>(
          `select id, kind, storage_key, visibility, filename, content_type, size_bytes, created_at
             from files where status = 'ready' order by created_at`,
        );
        return { tables: exported, files: fileRows };
      },
      { readOnly: true },
    );

    let budget = FILE_BUDGET_BYTES;
    let included = 0;
    let skipped = 0;
    const manifest = ["id,kind,filename,content_type,size_bytes,created_at,in_archive"];
    for (const f of files) {
      const size = Number(f.size_bytes);
      let inArchive = false;
      if (size <= budget) {
        try {
          zip.add(
            `files/${f.id}-${f.filename}`,
            await this.storage.read(f.visibility, f.storage_key),
          );
          budget -= size;
          inArchive = true;
          included += 1;
        } catch {
          skipped += 1;
        }
      } else skipped += 1;
      manifest.push(
        [
          f.id,
          f.kind,
          f.filename,
          f.content_type,
          String(size),
          f.created_at.toISOString(),
          inArchive ? "yes" : "no",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    zip.add("files/manifest.csv", Buffer.from(`${manifest.join("\n")}\n`, "utf8"));
    zip.add(
      "README.md",
      Buffer.from(
        [
          `# ${options.businessName}: all data`,
          "",
          `Exported from Autoforce Manager on ${options.generatedAt.toISOString()}.`,
          "",
          "- `tables/` — one CSV per table (UTF-8, comma-separated, header row). Amounts are in minor units (pesewas); dates are UTC (ISO 8601); JSON columns hold JSON.",
          "- `files/` — documents and photos uploaded or generated, named `<file id>-<name>`; `files/manifest.csv` lists every file and whether it is in this archive (very large exports leave some out — ask support for them).",
          "- Passwords, sign-in tokens and stored credentials are never exported.",
          "",
          "## Tables",
          "",
          ...tables.map((t) => `- \`${t.name}\` — ${t.rows} rows: ${t.columns.join(", ")}`),
          "",
        ].join("\n"),
        "utf8",
      ),
    );
    return {
      zip: zip.finish(),
      tables: tables.length,
      filesIncluded: included,
      filesSkipped: skipped,
    };
  }
}
