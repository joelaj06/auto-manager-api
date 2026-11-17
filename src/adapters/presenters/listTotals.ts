import { APPRAISAL_STATUSES } from "../../domain/dealer/Appraisal.js";
import { DEAL_STATUSES } from "../../domain/dealer/Deal.js";
import { QUOTE_STATUSES } from "../../domain/dealer/Quote.js";
import { STOCK_STATUSES } from "../../domain/dealer/StockUnit.js";
import { EXPENSE_STATUSES } from "../../domain/expenses/Expense.js";
import { INVOICE_STATUSES } from "../../domain/finance/Invoice.js";
import { CLAIM_STATUSES } from "../../domain/incidents/Incident.js";
import { MOVE_KINDS } from "../../domain/maintenance/Part.js";
import { WORK_ORDER_STATUSES } from "../../domain/maintenance/WorkOrder.js";
import { PURCHASE_STATUSES } from "../../domain/purchases/Purchase.js";
import { REMITTANCE_STATUSES } from "../../domain/remittances/Remittance.js";
import { BOOKING_STATUSES } from "../../domain/rentals/RentalBooking.js";
import { DAMAGE_STATUSES } from "../../domain/rentals/VehicleDamage.js";
import { AGREEMENT_STATUSES } from "../../domain/workpay/WorkPayAgreement.js";
import { listTotals } from "./pageHeaders.js";

/*
 * The money totals each paged list of money gives in its headers (decision 544), over the whole
 * filtered list, in the base currency (`X-Currency`; the billing currency on the console). The
 * list's query works the amounts out; these name the headers, which the OpenAPI document and
 * CORS take from the route.
 */

// --- finance ---
export const INVOICE_TOTALS = listTotals({
  amount: "invoice total",
  statuses: INVOICE_STATUSES,
  measures: { paid: "paid", outstanding: "left to pay on issued invoices" },
});
export const PAYMENT_TOTALS = listTotals({
  amount: "payment amount",
  statuses: ["recorded", "reversed"],
  measures: {
    in: "money in, not reversed",
    out: "money out, not reversed",
    unallocated: "not yet allocated, not reversed",
  },
});
export const CASH_SESSION_TOTALS = listTotals({
  measures: {
    opening_float: "opening float",
    cash_in: "cash in",
    cash_out: "cash out",
    variance: "variance on closing",
  },
});
export const LEDGER_LINE_TOTALS = listTotals({
  measures: { debit: "debits", credit: "credits" },
});
export const STATEMENT_LINE_TOTALS = listTotals({
  amount: "net amount, money in less money out",
  measures: { in: "money in", out: "money out" },
});

// --- expenses ---
export const EXPENSE_TOTALS = listTotals({
  amount: "expense amount",
  statuses: EXPENSE_STATUSES,
  measures: { net: "net of tax", tax: "tax" },
});

// --- remittances ---
export const REMITTANCE_TOTALS = listTotals({
  amount: "worth of the periods (the target, or what a variable period received)",
  statuses: REMITTANCE_STATUSES,
  measures: { received: "received", waived: "waived", outstanding: "still owed on targets" },
});

// --- purchases and maintenance ---
export const PURCHASE_TOTALS = listTotals({
  amount: "cost so far (the base amounts of the costs raised, rejected and void ones left out)",
  statuses: PURCHASE_STATUSES,
});
export const WORK_ORDER_TOTALS = listTotals({
  amount: "work order total",
  statuses: WORK_ORDER_STATUSES,
});

// --- incidents ---
export const CLAIM_TOTALS = listTotals({
  amount: "claimed",
  statuses: CLAIM_STATUSES,
  measures: {
    excess: "excess",
    approved: "approved by insurers",
    settled: "settled",
    expected: "still expected on submitted and approved claims",
  },
});
export const OFFENCE_TOTALS = listTotals({
  amount: "fines",
  statuses: ["unpaid", "contested", "paid", "waived"],
  measures: { driver: "fines the driver pays" },
});

// --- rentals ---
export const RENTAL_TOTALS = listTotals({
  amount: "charged",
  statuses: [...BOOKING_STATUSES, "expired"],
});
export const DAMAGE_TOTALS = listTotals({
  amount: "cost (the final cost, else the estimate)",
  statuses: DAMAGE_STATUSES,
  measures: {
    estimate: "estimates",
    final: "final costs",
    customer: "cost the customer is liable for",
  },
});

// --- parts ---
export const PART_MOVE_TOTALS = listTotals({
  amount: "stock value moved (issues, transfers out and write-downs negative)",
  statuses: MOVE_KINDS,
});

// --- dealership ---
export const STOCK_TOTALS = listTotals({
  amount: "asking value",
  statuses: STOCK_STATUSES,
});
export const DEAL_TOTALS = listTotals({
  amount: "agreed price (price less discount)",
  statuses: DEAL_STATUSES,
  measures: { discount: "discounts", trade_in: "trade-ins taken" },
});
export const QUOTE_TOTALS = listTotals({
  amount: "quoted price (price less discount)",
  statuses: QUOTE_STATUSES,
  measures: { discount: "discounts", trade_in: "trade-ins offered", deposit: "deposits asked" },
});
export const APPRAISAL_TOTALS = listTotals({
  amount: "appraised value",
  statuses: APPRAISAL_STATUSES,
});

// --- work and pay ---
export const AGREEMENT_TOTALS = listTotals({
  amount: "total price",
  statuses: AGREEMENT_STATUSES,
  measures: {
    financed: "financed",
    deposit_paid: "deposits paid",
    deposit_outstanding: "deposits still owed",
  },
});
export const ARREARS_TOTALS = listTotals({
  amount: "outstanding",
  statuses: AGREEMENT_STATUSES,
  measures: { overdue: "overdue", penalties_outstanding: "late fees outstanding" },
});

// --- platform billing and resellers, in the currency we bill in ---
export const BILLING_INVOICE_TOTALS = listTotals({
  amount: "invoice total",
  statuses: ["open", "paid", "void"],
  measures: { paid: "paid", outstanding: "left to pay on open invoices" },
});
export const GATEWAY_TRANSACTION_TOTALS = listTotals({
  amount: "amount charged",
  statuses: ["pending", "succeeded", "failed", "abandoned", "review"],
  measures: { fees: "gateway fees" },
});
export const GATEWAY_RECONCILIATION_TOTALS = listTotals({
  measures: { ours: "what we recorded", provider: "what the provider reported", fees: "fees" },
});
export const COMMISSION_ENTRY_TOTALS = listTotals({
  amount: "commission (adjustments and clawbacks negative)",
  statuses: ["accrued", "payable", "paid"],
  measures: { base: "payments the commission was earned on" },
});
export const PAYOUT_TOTALS = listTotals({
  amount: "paid out",
  statuses: ["awaiting_approval", "paid", "reversed"],
});
