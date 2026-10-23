import type { InvoiceProps } from "../../domain/billing/Invoice.js";
import type { PaymentRecord } from "../../domain/repositories/IBillingRepository.js";

/**
 * Reseller commissions follow licence payments (docs/29 §5): called inside the billing unit of
 * work, after the payment (or its refund) was applied to the invoice.
 */
export interface ICommissionHooks {
  paymentApplied(payment: PaymentRecord, invoice: InvoiceProps): Promise<void>;
  paymentRefunded(
    payment: PaymentRecord,
    refund: Readonly<{ id: string; amountMinor: number }>,
    invoice: InvoiceProps,
  ): Promise<void>;
}
