import type { Appraisal, AppraisalStatus } from "../../domain/dealer/Appraisal.js";
import type { Deal, DealStatus, ScheduledInstalment } from "../../domain/dealer/Deal.js";
import type { PaymentMethod } from "../../domain/finance/Payment.js";

/** Payments recorded for a deal (deposits, instalments, the bank's disbursement …). */
export const DEAL_SOURCE = "dealer_deal";

export type DealFilter = Readonly<{
  branchIds: "all" | readonly string[];
  salesExecutiveId?: string;
  statuses?: readonly DealStatus[];
  customerId?: string;
  vehicleId?: string;
  leadId?: string;
  limit: number;
  beforeId?: string;
}>;

/** A payment recorded for the deal (deposits, instalments, the bank's disbursement …). */
export type DealPayment = Readonly<{
  id: string;
  number: string;
  method: PaymentMethod;
  paidOn: string;
  amountMinor: number;
  unallocatedMinor: number;
  status: "recorded" | "reversed";
  notes: string | null;
}>;

export type DealCustomer = Readonly<{
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  ghanaCardNumber: string | null;
}>;

export interface IDeals {
  insert(deal: Deal): Promise<void>;
  update(deal: Deal): Promise<void>;
  get(id: string): Promise<Deal | null>;
  lock(id: string): Promise<Deal | null>;
  list(filter: DealFilter): Promise<Deal[]>;
  /** The open deal (draft, reserved or sold) on the vehicle, if any. */
  liveForVehicle(vehicleId: string): Promise<string | null>;
  /** Payments for the deal not yet used on its invoices, oldest first. */
  prepayments(dealId: string): Promise<{ paymentId: string; unallocatedMinor: number }[]>;
  payments(dealId: string): Promise<DealPayment[]>;
  saveSchedule(dealId: string, schedule: readonly ScheduledInstalment[]): Promise<void>;
  schedule(dealId: string): Promise<ScheduledInstalment[]>;
  /** Reserved deals whose hold ended before `today`. */
  lapsedReservations(today: string): Promise<string[]>;
  /** In-house deals with an instalment due before `today` not yet told overdue. */
  withUnnoticedDue(today: string): Promise<string[]>;
  markNoticed(dealId: string, numbers: readonly number[], at: Date): Promise<void>;
  noticed(dealId: string): Promise<Set<number>>;
  customer(id: string): Promise<DealCustomer | null>;
}

export type AppraisalFilter = Readonly<{
  branchIds: "all" | readonly string[];
  statuses?: readonly AppraisalStatus[];
  leadId?: string;
  customerId?: string;
  limit: number;
  beforeId?: string;
}>;

export interface IAppraisals {
  insert(appraisal: Appraisal): Promise<void>;
  update(appraisal: Appraisal): Promise<void>;
  get(id: string): Promise<Appraisal | null>;
  lock(id: string): Promise<Appraisal | null>;
  list(filter: AppraisalFilter): Promise<Appraisal[]>;
}
