import type { CashSession } from "../finance/CashSession.js";
import type { Invoice } from "../finance/Invoice.js";
import type { Payment } from "../finance/Payment.js";

/** Invoices of the current tenant (tenant unit of work). */
export interface IInvoiceRepository {
  findById(id: string): Promise<Invoice | null>;
  lockById(id: string): Promise<Invoice | null>;
  /** Inserts or updates the invoice with its lines. */
  save(invoice: Invoice): Promise<void>;
  /** Deletes a draft (never an issued invoice). */
  deleteDraft(id: string): Promise<void>;
}

export type Allocation = Readonly<{
  id: string;
  paymentId: string;
  invoiceId: string;
  amountMinor: number;
  allocatedAt: Date;
  allocatedBy: string | null;
  releasedAt: Date | null;
  releasedBy: string | null;
  releaseReason: string | null;
}>;

/** Payments and their allocations (tenant unit of work). */
export interface IPaymentRepository {
  findById(id: string): Promise<Payment | null>;
  lockById(id: string): Promise<Payment | null>;
  save(payment: Payment): Promise<void>;
  allocations(filter: Readonly<{ paymentId?: string; invoiceId?: string }>): Promise<Allocation[]>;
  saveAllocation(allocation: Allocation): Promise<void>;
}

/** Cash sessions (tenant unit of work). */
export interface ICashSessionRepository {
  findById(id: string): Promise<CashSession | null>;
  lockById(id: string): Promise<CashSession | null>;
  lockOpenFor(cashierId: string): Promise<CashSession | null>;
  save(session: CashSession): Promise<void>;
}
