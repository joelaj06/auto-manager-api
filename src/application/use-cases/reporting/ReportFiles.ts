import { Money } from "../../../domain/money/Money.js";
import type {
  Cell,
  FileFormat,
  ReportColumn,
  ReportTable,
} from "../../../domain/reporting/Report.js";
import type { IClock } from "../../ports/IClock.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IPdfRenderer, PdfBlock } from "../../ports/IPdfRenderer.js";
import type { IReportFileWriter, RenderedReport } from "../../ports/IReportJobs.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BusinessLogo } from "../../services/BusinessLogo.js";
import { localDateTime } from "../../services/TenantLocalTime.js";

const CONTENT_TYPES: Readonly<Record<FileFormat, string>> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

const NUMBER = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });

/** A cell as printed: money with its currency code, percentages with the sign. */
export function cellText(column: ReportColumn, value: Cell, currency: string): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  switch (column.type) {
    case "money":
      return Money.ofMinor(value, currency).formatAscii();
    case "percent":
      return `${value.toFixed(1)}%`;
    default:
      return NUMBER.format(value);
  }
}

/**
 * Writes a report table to a file: CSV and XLSX through the spreadsheet writer, PDF as a
 * letterhead document (like every PDF the system issues) with the summary and the table.
 */
export class ReportFiles {
  constructor(
    private readonly deps: Readonly<{
      writer: IReportFileWriter;
      pdf: IPdfRenderer;
      unitOfWork: IUnitOfWork;
      organisation: IOrganisationSettings;
      logo: BusinessLogo;
      clock: IClock;
    }>,
  ) {}

  async render(
    table: ReportTable,
    format: FileFormat,
    options: Readonly<{ landscape?: boolean }> = {},
  ): Promise<RenderedReport> {
    const contentType = CONTENT_TYPES[format];
    if (format === "csv")
      return { content: this.deps.writer.csv(table), contentType, extension: format };
    if (format === "xlsx")
      return { content: this.deps.writer.xlsx(table), contentType, extension: format };
    return {
      content: await this.pdf(table, options.landscape ?? false),
      contentType,
      extension: format,
    };
  }

  private async pdf(table: ReportTable, landscape: boolean): Promise<Buffer> {
    const { deps } = this;
    const organisation = await deps.unitOfWork.run(() => deps.organisation.get());
    const now = deps.clock.now();
    const local = localDateTime(now, organisation.timezone);
    const time = `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
    const weights = table.columns.map((c) => c.width ?? 1);
    const total = weights.reduce((s, w) => s + w, 0);
    const right = (c: ReportColumn) => c.type !== "text" && c.type !== "date";
    const line = (row: Readonly<Record<string, Cell>>) =>
      table.columns.map((c) => cellText(c, row[c.key] ?? null, table.currency));
    const blocks: PdfBlock[] = [
      ...(table.summary.length === 0 ? [] : [{ type: "fields" as const, rows: table.summary }]),
      {
        type: "table",
        columns: table.columns.map((c, i) => ({
          header: c.header,
          width: weights[i]! / total,
          ...(right(c) ? { align: "right" as const } : {}),
        })),
        rows: table.rows.map(line),
        ...(table.totals === null ? {} : { total: line(table.totals) }),
      },
      ...(table.rows.length === 0
        ? [{ type: "paragraph" as const, text: "Nothing to report.", muted: true }]
        : []),
    ];
    return deps.pdf.render({
      title: table.title,
      reference: table.subtitle,
      issuer: {
        name: organisation.legalName ?? organisation.name,
        lines: [
          ...(organisation.tin === null ? [] : [`TIN ${organisation.tin}`]),
          ...(organisation.contactPhone === null ? [] : [organisation.contactPhone]),
          ...(organisation.contactEmail === null ? [] : [organisation.contactEmail]),
        ],
        logo: await deps.logo.bytes(organisation.logoStorageKey),
      },
      ...(landscape ? { landscape: true } : {}),
      blocks,
      footer: `${organisation.name} · ${table.title} · generated ${local.date} ${time} with Autoforce Manager`,
      createdAt: now,
    });
  }
}
