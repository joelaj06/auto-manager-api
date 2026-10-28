import type { Expense } from "../../../domain/expenses/Expense.js";
import {
  ageBills,
  daysOverdue,
  dueOn,
  PayablesRuleError,
  settleBills,
  withholdingOf,
  type PayableBucket,
} from "../../../domain/finance/Payables.js";
import type { PaymentMethod } from "../../../domain/finance/Payment.js";
import { Postings, toBase } from "../../../domain/finance/Postings.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { IExpenseRepository } from "../../../domain/repositories/IExpenseRepository.js";
import type { AuthorizationPolicy } from "../../authorization/AuthorizationPolicy.js";
import type { Principal } from "../../authorization/Principal.js";
import { SupplierNotFoundError } from "../../errors/PartyErrors.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type {
  ILedger,
  IPartyDirectory,
  IPaymentReversalListener,
  LedgerLineView,
} from "../../ports/IFinanceRecords.js";
import type { IPayables, OpenBill } from "../../ports/IPayables.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { PaymentRecording, PaymentView } from "../finance/PaymentRecording.js";
import { recordUserAction } from "../reference/userAudit.js";

/** The payment source of a supplier payment: its id is the supplier's. */
export const SUPPLIER_PAYMENT_SOURCE = "supplier_payment";
const MAX_BILLS = 50;
const MAX_LINES = 1_000;

type Buckets = Readonly<Record<PayableBucket, MoneyJson>>;

export type BillView = Readonly<{
  expenseId: string;
  number: string | null;
  branchId: string;
  billDate: string;
  dueOn: string;
  daysOverdue: number;
  description: string;
  reference: string | null;
  amount: MoneyJson;
  amountBase: MoneyJson;
}>;

export type AgedPayables = Readonly<{
  asOf: string;
  total: MoneyJson;
  buckets: Buckets;
  payees: readonly Readonly<{
    payee: Readonly<{ type: "supplier" | "driver"; id: string }> | null;
    name: string;
    bills: number;
    total: MoneyJson;
    buckets: Buckets;
  }>[];
}>;

export type SupplierBills = Readonly<{
  supplier: Readonly<{ id: string; name: string }>;
  asOf: string;
  total: MoneyJson;
  buckets: Buckets;
  bills: readonly BillView[];
}>;

export type SupplierStatement = Readonly<{
  supplier: Readonly<{ id: string; name: string }>;
  from: string;
  to: string;
  /** What the business owed the supplier before `from` (negative: paid in advance). */
  opening: MoneyJson;
  lines: readonly Readonly<{
    date: string;
    number: string;
    description: string;
    sourceType: string;
    sourceId: string;
    billed: MoneyJson | null;
    paid: MoneyJson | null;
    balance: MoneyJson;
  }>[];
  closing: MoneyJson;
  openBills: Readonly<{ count: number; total: MoneyJson; buckets: Buckets }>;
}>;

export type SupplierPaymentInput = Readonly<{
  expenseIds: readonly string[];
  method: PaymentMethod;
  paidOn?: string;
  fxRate?: string | null;
  reference?: string | null;
  momoNetwork?: "mtn" | "telecel" | "at" | null;
  /** The branch the money leaves; by default the bills' branch when they share one. */
  branchId?: string;
  /** Withholding tax, a percentage of the bills before VAT (e.g. "7.5"). */
  withholdingRate?: string | null;
  notes?: string | null;
}>;

export type SupplierPaymentView = Readonly<{
  payment: PaymentView;
  bills: readonly Readonly<{
    expenseId: string;
    number: string | null;
    amount: MoneyJson;
    amountBase: MoneyJson;
    paidBase: MoneyJson;
    fxDifference: MoneyJson;
  }>[];
  withholding: Readonly<{ rate: string; amount: MoneyJson; amountBase: MoneyJson }> | null;
  fxDifference: MoneyJson;
}>;

/**
 * Supplier payables (docs/11 §5, docs/13): approved expenses are bills owed to their payee, due
 * after the supplier's payment terms; aged payables, a supplier's open bills and statement from
 * the payables account; and one payment settling several of a supplier's bills, with withholding
 * tax kept back and the exchange difference of foreign-currency bills (decisions 415–420).
 */
export class SupplierPayables {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      payables: IPayables;
      expenses: IExpenseRepository;
      ledger: ILedger;
      parties: IPartyDirectory;
      posting: LedgerPosting;
      payments: PaymentRecording;
      policy: AuthorizationPolicy;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
    }>,
  ) {}

  aged(actor: Principal, query: Readonly<{ asOf?: string }>): Promise<AgedPayables> {
    const { deps } = this;
    deps.policy.require(actor, "finance.payables.view");
    return deps.unitOfWork.run(async () => {
      const asOf = query.asOf ?? (await deps.calendar.today());
      const base = await deps.posting.baseCurrency();
      const bills = await deps.payables.openBills({ asOf });
      const groups = new Map<string, OpenBill[]>();
      for (const bill of bills) {
        const key =
          bill.payee === null ? `name:${bill.payeeName}` : `${bill.payee.type}:${bill.payee.id}`;
        groups.set(key, [...(groups.get(key) ?? []), bill]);
      }
      const payees = [...groups.values()]
        .map((group) => {
          const aged = ageing(group);
          return {
            payee: group[0]!.payee,
            name: group[0]!.payeeName,
            bills: group.length,
            totalMinor: sum(group),
            buckets: aged,
          };
        })
        .sort((a, b) => b.totalMinor - a.totalMinor || a.name.localeCompare(b.name));
      const m = money(base);
      return {
        asOf,
        total: m(sum(bills)),
        buckets: buckets(ageing(bills), m),
        payees: payees.map(({ totalMinor, buckets: b, ...p }) => ({
          ...p,
          total: m(totalMinor),
          buckets: buckets(b, m),
        })),
      };

      function ageing(group: readonly OpenBill[]) {
        return ageBills(
          group.map((b) => ({
            dueOn: dueOn(b.billDate, b.termsDays),
            amountMinor: b.amountBaseMinor,
          })),
          asOf,
        );
      }
    });
  }

  bills(
    actor: Principal,
    supplierId: string,
    query: Readonly<{ asOf?: string }>,
  ): Promise<SupplierBills> {
    const { deps } = this;
    deps.policy.require(actor, "finance.payables.view");
    return deps.unitOfWork.run(async () => {
      const supplier = await this.supplier(supplierId);
      const asOf = query.asOf ?? (await deps.calendar.today());
      const base = await deps.posting.baseCurrency();
      const bills = await deps.payables.openBills({ supplierId, asOf });
      const m = money(base);
      return {
        supplier,
        asOf,
        total: m(sum(bills)),
        buckets: buckets(this.age(bills, asOf), m),
        bills: bills.map((b) => billView(b, asOf, base)),
      };
    });
  }

  statement(
    actor: Principal,
    supplierId: string,
    period: Readonly<{ from?: string; to?: string }>,
  ): Promise<SupplierStatement> {
    const { deps } = this;
    deps.policy.require(actor, "finance.payables.view");
    return deps.unitOfWork.run(async () => {
      const supplier = await this.supplier(supplierId);
      const today = await deps.calendar.today();
      const to = period.to ?? today;
      const from = period.from ?? `${to.slice(0, 7)}-01`;
      if (from > to) throw new PayablesRuleError("The period starts after it ends");
      const base = await deps.posting.baseCurrency();
      const m = money(base);
      const accounts = await deps.posting.accounts();
      const accountIds = [accounts("payables")];
      const party = { type: "supplier" as const, id: supplierId };
      // The payables account is a liability: what is owed is credit less debit.
      const opening = -(await deps.ledger.partyNet(accountIds, party, from));
      const rows: LedgerLineView[] = await deps.ledger.lines({
        accountIds,
        party,
        from,
        to,
        limit: MAX_LINES,
      });
      let balance = opening;
      const lines = [...rows].reverse().map((l) => {
        balance += l.creditMinor - l.debitMinor;
        return {
          date: l.date,
          number: l.number,
          description: l.description,
          sourceType: l.sourceType,
          sourceId: l.sourceId,
          billed: l.creditMinor > 0 ? m(l.creditMinor) : null,
          paid: l.debitMinor > 0 ? m(l.debitMinor) : null,
          balance: m(balance),
        };
      });
      const open = await deps.payables.openBills({ supplierId, asOf: today });
      return {
        supplier,
        from,
        to,
        opening: m(opening),
        lines,
        closing: m(balance),
        openBills: {
          count: open.length,
          total: m(sum(open)),
          buckets: buckets(this.age(open, today), m),
        },
      };
    });
  }

  /**
   * Pays several approved bills of one supplier in one payment (decision 418): bills in one
   * currency, paid in it at the payment date's rate; the tax withheld is owed to the tax
   * authority and each bill's exchange difference posted, then every bill is marked paid.
   */
  pay(
    actor: Principal,
    supplierId: string,
    input: SupplierPaymentInput,
  ): Promise<SupplierPaymentView> {
    const { deps } = this;
    deps.policy.require(actor, "suppliers.payments.make");
    return deps.unitOfWork.run(async () => {
      const supplier = await this.supplier(supplierId);
      const ids = [...new Set(input.expenseIds)];
      if (ids.length === 0 || ids.length > MAX_BILLS)
        throw new PayablesRuleError(`Pay 1 to ${MAX_BILLS} bills at a time`);
      if (ids.length !== input.expenseIds.length)
        throw new PayablesRuleError("A bill is listed twice");
      const expenses: Expense[] = [];
      for (const id of ids) {
        const expense = await deps.expenses.lockById(id);
        const p = expense?.snapshot();
        if (
          expense === null ||
          p === undefined ||
          p.payee?.type !== "supplier" ||
          p.payee.id !== supplierId
        )
          throw new PayablesRuleError(`Bill ${id} is not one of ${supplier.name}'s`);
        if (p.status !== "approved")
          throw new PayablesRuleError(`Bill ${p.number ?? id} is not approved and unpaid`);
        expenses.push(expense);
      }
      const bills = expenses.map((e) => e.snapshot());
      const currency = bills[0]!.currency;
      if (bills.some((b) => b.currency !== currency))
        throw new PayablesRuleError("Pay bills in one currency at a time");
      const branches = [...new Set(bills.map((b) => b.branchId))];
      const branchId = input.branchId ?? (branches.length === 1 ? branches[0]! : null);
      if (branchId === null)
        throw new PayablesRuleError("The bills are of several branches: name the paying branch");

      const grossMinor = bills.reduce((s, b) => s + b.amountMinor, 0);
      const rate = input.withholdingRate ?? null;
      const withheldMinor =
        rate === null
          ? 0
          : withholdingOf(
              bills.reduce((s, b) => s + b.netMinor, 0),
              rate,
            );
      if (withheldMinor >= grossMinor)
        throw new PayablesRuleError("The tax withheld leaves nothing to pay");
      const numbers = bills.map((b) => b.number ?? "").join(", ");
      const accounts = await deps.posting.accounts();
      const base = await deps.posting.baseCurrency();
      const payment = await deps.payments.record(
        actor,
        {
          direction: "out",
          method: input.method,
          partyType: "supplier",
          partyId: supplierId,
          branchId,
          currency,
          fxRate: input.fxRate ?? null,
          amount: Money.ofMinor(grossMinor - withheldMinor, currency).toDecimalString(),
          counterAccountId: accounts("payables"),
          reference: input.reference ?? null,
          momoNetwork: input.momoNetwork ?? null,
          notes: input.notes ?? `Bills ${numbers}`.slice(0, 2_000),
          ...(input.paidOn === undefined ? {} : { paidOn: input.paidOn }),
          source: { type: SUPPLIER_PAYMENT_SOURCE, id: supplierId },
        },
        "suppliers.payments.make",
      );
      const grossBaseMinor = toBase(grossMinor, currency, payment.fxRate, base);
      const withheldBaseMinor = grossBaseMinor - payment.amountBase.amountMinor;
      if (withheldMinor > 0)
        await deps.posting.post(
          Postings.supplierWithholding(
            {
              paymentId: payment.id,
              amountMinor: withheldBaseMinor,
              branchId,
              supplierId,
              date: payment.paidOn,
              description: `Withholding tax ${rate}% on ${supplier.name} bills ${numbers}`,
            },
            accounts,
          ),
          actor.userId,
        );
      const settled = settleBills(bills, grossBaseMinor, base);
      const differenceMinor = settled.reduce((s, b) => s + b.differenceMinor, 0);
      if (differenceMinor !== 0)
        await deps.posting.post(
          Postings.payableExchangeDifference(
            {
              paymentId: payment.id,
              difference: differenceMinor,
              branchId,
              party: { type: "supplier", id: supplierId },
              date: payment.paidOn,
              description: `Exchange difference on ${supplier.name} bills ${numbers} paid in ${currency}`,
            },
            accounts,
          ),
          actor.userId,
        );
      const now = deps.clock.now();
      for (const [i, expense] of expenses.entries()) {
        expense.markPaid(payment.id, now, settled[i]!.differenceMinor);
        await deps.expenses.save(expense);
      }
      await recordUserAction(deps, actor.userId, {
        action: "supplier.payment_made",
        entityType: "supplier",
        entityId: supplierId,
        metadata: {
          paymentId: payment.id,
          expenseIds: ids,
          withheldMinor,
          fxDifferenceMinor: differenceMinor,
        },
      });
      const m = money(base);
      return {
        payment,
        bills: bills.map((b, i) => ({
          expenseId: b.id,
          number: b.number,
          amount: Money.ofMinor(b.amountMinor, currency).toJSON(),
          amountBase: m(b.amountBaseMinor),
          paidBase: m(settled[i]!.shareBaseMinor),
          fxDifference: m(settled[i]!.differenceMinor),
        })),
        withholding:
          rate === null
            ? null
            : {
                rate,
                amount: Money.ofMinor(withheldMinor, currency).toJSON(),
                amountBase: m(withheldBaseMinor),
              },
        fxDifference: m(differenceMinor),
      };
    });
  }

  private async supplier(id: string): Promise<Readonly<{ id: string; name: string }>> {
    const party = await this.deps.parties.find("supplier", id);
    if (party === null) throw new SupplierNotFoundError();
    return { id, name: party.name };
  }

  private age(bills: readonly OpenBill[], asOf: string) {
    return ageBills(
      bills.map((b) => ({ dueOn: dueOn(b.billDate, b.termsDays), amountMinor: b.amountBaseMinor })),
      asOf,
    );
  }
}

/**
 * A reversed supplier payment reopens every bill it paid and undoes the tax withheld and the
 * exchange difference (decision 419).
 */
export class SupplierPaymentListener implements IPaymentReversalListener {
  readonly sourceType = SUPPLIER_PAYMENT_SOURCE;

  constructor(
    private readonly deps: Readonly<{
      expenses: IExpenseRepository;
      posting: LedgerPosting;
      calendar: TenantCalendar;
      clock: IClock;
    }>,
  ) {}

  async paymentReversed(_supplierId: string, paymentId: string): Promise<void> {
    const { deps } = this;
    const today = await deps.calendar.today();
    for (const type of ["supplier_wht", "payable_fx"])
      await deps.posting.reverse({ type, id: paymentId }, today, "Supplier payment reversed", null);
    for (const expense of await deps.expenses.lockByPayment(paymentId)) {
      expense.reopen(deps.clock.now());
      await deps.expenses.save(expense);
    }
  }
}

const money = (base: string) => (minor: number) => Money.ofMinor(minor, base).toJSON();
const sum = (bills: readonly OpenBill[]) => bills.reduce((s, b) => s + b.amountBaseMinor, 0);
const buckets = (b: Record<PayableBucket, number>, m: (minor: number) => MoneyJson): Buckets => ({
  current: m(b.current),
  days1to30: m(b.days1to30),
  days31to60: m(b.days31to60),
  days61to90: m(b.days61to90),
  over90: m(b.over90),
});

function billView(b: OpenBill, asOf: string, base: string): BillView {
  const due = dueOn(b.billDate, b.termsDays);
  return {
    expenseId: b.expenseId,
    number: b.number,
    branchId: b.branchId,
    billDate: b.billDate,
    dueOn: due,
    daysOverdue: daysOverdue(due, asOf),
    description: b.description,
    reference: b.reference,
    amount: Money.ofMinor(b.amountMinor, b.currency).toJSON(),
    amountBase: Money.ofMinor(b.amountBaseMinor, base).toJSON(),
  };
}
