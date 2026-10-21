import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IClock } from "../../ports/IClock.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IPdfRenderer, PdfBlock, PdfDocument } from "../../ports/IPdfRenderer.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BusinessLogo } from "../../services/BusinessLogo.js";
import { localDateTime } from "../../services/TenantLocalTime.js";
import type { PaymentRecording, ReceiptView } from "../finance/PaymentRecording.js";
import type { DriverLedger, DriverStatement } from "../remittances/DriverLedger.js";

export type PdfFile = Readonly<{ filename: string; content: Buffer }>;

type DriverRef = Readonly<{ id: string; code: string; firstName: string; lastName: string }>;

const METHODS: Readonly<Record<string, string>> = {
  cash: "Cash",
  momo: "Mobile money",
  bank_transfer: "Bank transfer",
  cheque: "Cheque",
  card: "Card",
};
const NETWORKS: Readonly<Record<string, string>> = { mtn: "MTN", telecel: "Telecel", at: "AT" };

const ascii = (m: MoneyJson) => Money.ofMinor(m.amountMinor, m.currency).formatAscii();

/**
 * PDFs of the basics (P2-10, docs/24): payment receipts and driver statements. They print the
 * same figures the JSON views return — themselves taken from the payments and the ledger — so a
 * receipt always agrees with the books. Staff get them within their permissions; a driver gets
 * their own through the driver app.
 */
export class PrintedDocuments {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      payments: PaymentRecording;
      ledger: DriverLedger;
      organisation: IOrganisationSettings;
      logo: BusinessLogo;
      renderer: IPdfRenderer;
      clock: IClock;
    }>,
  ) {}

  async receipt(actor: Principal, paymentId: string): Promise<PdfFile> {
    return this.receiptPdf(await this.deps.payments.receipt(actor, paymentId));
  }

  async driverReceipt(driverId: string, paymentId: string): Promise<PdfFile> {
    return this.receiptPdf(
      await this.deps.payments.receiptForParty({ type: "driver", id: driverId }, paymentId),
    );
  }

  async driverStatement(
    actor: Principal,
    driverId: string,
    period: Readonly<{ from?: string; to?: string }>,
  ): Promise<PdfFile> {
    return this.statementPdf(await this.deps.ledger.statement(actor, driverId, period));
  }

  async ownStatement(
    driver: DriverRef,
    period: Readonly<{ from?: string; to?: string }>,
  ): Promise<PdfFile> {
    return this.statementPdf(await this.deps.ledger.statementOf(driver, period));
  }

  private async receiptPdf(r: ReceiptView): Promise<PdfFile> {
    const method =
      r.method === "momo" && r.momoNetwork !== null
        ? `${METHODS.momo} (${NETWORKS[r.momoNetwork] ?? r.momoNetwork})`
        : (METHODS[r.method] ?? r.method);
    const applied: string[][] = r.appliedTo.map((a) => [a.description, ascii(a.amount)]);
    if (r.credit.amountMinor > 0)
      applied.push(["Kept as credit for later payments", ascii(r.credit)]);
    const blocks: PdfBlock[] = [
      {
        type: "fields",
        rows: [
          { label: "Received from", value: r.receivedFrom },
          { label: "Date", value: r.date },
          { label: "Payment method", value: method },
          { label: "Reference", value: r.reference ?? "—" },
        ],
      },
      { type: "amount", label: "Amount received", value: ascii(r.amount) },
      { type: "heading", text: "Applied to" },
      {
        type: "table",
        columns: [
          { header: "Description", width: 0.7 },
          { header: "Amount", width: 0.3, align: "right" },
        ],
        rows: applied,
        total: ["Total", ascii(r.amount)],
      },
    ];
    if (r.status === "reversed")
      blocks.push({
        type: "paragraph",
        text: "This payment was reversed: the money was not received after all and this receipt is no longer valid.",
      });
    blocks.push({
      type: "paragraph",
      muted: true,
      text: `Receipt ${r.number} issued by ${r.business.name}. Keep it as proof of payment.`,
    });
    return {
      filename: `${r.number}.pdf`,
      content: await this.render({
        title: "Receipt",
        reference: r.number,
        ...(r.status === "reversed" ? { watermark: "REVERSED" } : {}),
        blocks,
      }),
    };
  }

  private async statementPdf(s: DriverStatement): Promise<PdfFile> {
    const money = (m: MoneyJson | null) => (m === null ? "" : ascii(m));
    const blocks: PdfBlock[] = [
      {
        type: "fields",
        rows: [
          { label: "Driver", value: `${s.driver.name} (${s.driver.code})` },
          { label: "Period", value: `${s.from} to ${s.to}` },
          { label: "Opening balance", value: ascii(s.opening) },
          { label: "Closing balance", value: ascii(s.closing) },
        ],
      },
      {
        type: "amount",
        label:
          s.closing.amountMinor >= 0 ? "Balance owed by the driver" : "Balance owed to the driver",
        value: ascii({ ...s.closing, amountMinor: Math.abs(s.closing.amountMinor) }),
      },
      { type: "heading", text: "Transactions" },
      {
        type: "table",
        columns: [
          { header: "Date", width: 0.13 },
          { header: "Ref", width: 0.17 },
          { header: "Description", width: 0.31 },
          { header: "Charge", width: 0.13, align: "right" },
          { header: "Credit", width: 0.13, align: "right" },
          { header: "Balance", width: 0.13, align: "right" },
        ],
        rows: [
          [s.from, "", "Opening balance", "", "", ascii(s.opening)],
          ...s.lines.map((l) => [
            l.date,
            l.number,
            l.description,
            money(l.charge),
            money(l.credit),
            ascii(l.balance),
          ]),
        ],
        total: ["", "", "Closing balance", "", "", ascii(s.closing)],
      },
      { type: "heading", text: "Unpaid remittances by age" },
      {
        type: "table",
        columns: [
          { header: "0–7 days", width: 0.25, align: "right" },
          { header: "8–30 days", width: 0.25, align: "right" },
          { header: "Over 30 days", width: 0.25, align: "right" },
          { header: "Total", width: 0.25, align: "right" },
        ],
        rows: [
          [
            ascii(s.shortfalls.ageing.days0to7),
            ascii(s.shortfalls.ageing.days8to30),
            ascii(s.shortfalls.ageing.over30),
            ascii(s.shortfalls.total),
          ],
        ],
      },
      {
        type: "paragraph",
        muted: true,
        text: "Charges are what the driver owes (remittance targets, invoices, deductions, advances); credits are payments, bonuses and money owed to the driver.",
      },
    ];
    return {
      filename: `statement-${s.driver.code}-${s.from}-${s.to}.pdf`,
      content: await this.render({
        title: "Driver statement",
        reference: `${s.from} to ${s.to}`,
        blocks,
      }),
    };
  }

  private async render(
    content: Pick<PdfDocument, "title" | "reference" | "blocks" | "watermark">,
  ): Promise<Buffer> {
    const { deps } = this;
    const organisation = await deps.unitOfWork.run(() => deps.organisation.get());
    const now = deps.clock.now();
    const local = localDateTime(now, organisation.timezone);
    const time = `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
    return deps.renderer.render({
      ...content,
      issuer: {
        name: organisation.legalName ?? organisation.name,
        lines: [
          ...(organisation.tin === null ? [] : [`TIN ${organisation.tin}`]),
          ...(organisation.contactPhone === null ? [] : [organisation.contactPhone]),
          ...(organisation.contactEmail === null ? [] : [organisation.contactEmail]),
        ],
        logo: await deps.logo.bytes(organisation.logoStorageKey),
      },
      footer: `${organisation.name} · generated ${local.date} ${time} with Autoforce Manager`,
      createdAt: now,
    });
  }
}
