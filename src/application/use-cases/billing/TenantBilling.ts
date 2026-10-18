import type { PaymentRecord } from "../../../domain/repositories/IBillingRepository.js";

/** A payment as the tenant sees it (no internal notes or staff ids). */
export type TenantPaymentView = Pick<
  PaymentRecord,
  "id" | "invoiceId" | "method" | "reference" | "amountMinor" | "currency" | "receivedAt"
>;

const forTenant = (p: PaymentRecord): TenantPaymentView => ({
  id: p.id,
  invoiceId: p.invoiceId,
  method: p.method,
  reference: p.reference,
  amountMinor: p.amountMinor,
  currency: p.currency,
  receivedAt: p.receivedAt,
});
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { InvoiceView, ManualBilling } from "./ManualBilling.js";
import type { SubscriptionAdministration, SubscriptionView } from "./SubscriptionAdministration.js";

/**
 * The tenant's Billing tab (docs/25 §6, read part): subscription and entitlements, invoices and
 * payment history. Always the signed-in user's own tenant. Paying online comes in phase 2.
 */
export class TenantBilling {
  constructor(
    private readonly deps: Readonly<{
      subscriptions: SubscriptionAdministration;
      billing: ManualBilling;
      tenantContext: ITenantContext;
    }>,
  ) {}

  subscription(): Promise<SubscriptionView> {
    return this.deps.subscriptions.view(this.tenantId());
  }

  async invoices(filter: Readonly<{ limit: number; before?: string }>): Promise<InvoiceView[]> {
    const invoices = await this.deps.billing.invoices({ ...filter, tenantId: this.tenantId() });
    return invoices
      .filter((i) => i.status !== "void")
      .map(({ createdBy: _c, ...i }) => i as InvoiceView);
  }

  async invoice(invoiceId: string): Promise<InvoiceView> {
    const {
      createdBy: _c,
      payments,
      ...invoice
    } = await this.deps.billing.invoice(invoiceId, this.tenantId());
    return { ...invoice, payments: (payments ?? []).map(forTenant) } as unknown as InvoiceView;
  }

  async transactions(): Promise<TenantPaymentView[]> {
    return (await this.deps.billing.payments(this.tenantId())).map(forTenant);
  }

  private tenantId(): string {
    return this.deps.tenantContext.currentTenantId().value;
  }
}
