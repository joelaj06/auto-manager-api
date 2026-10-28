import type { PaymentMethod } from "../../../domain/finance/Payment.js";
import type { IInvoiceRepository } from "../../../domain/repositories/IFinanceRepositories.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import { RentalBookingError, type RentalBooking } from "../../../domain/rentals/RentalBooking.js";
import { RentalDeposit, type DepositStatus } from "../../../domain/rentals/RentalDeposit.js";
import { rentalInvoiceLines } from "../../../domain/rentals/RentalInvoicing.js";
import type { AuthorizationPolicy } from "../../authorization/AuthorizationPolicy.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import { PermissionDeniedError } from "../../errors/AuthErrors.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type {
  BookingEventType,
  IRentalBookings,
  Renter,
  RenterHistory,
} from "../../ports/IRentalBookings.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { TenantCalendar } from "../../services/TenantCalendar.js";
import type { Invoicing } from "../finance/Invoicing.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { PaymentRecording } from "../finance/PaymentRecording.js";
import type { VehicleAccess } from "../vehicles/VehicleAccess.js";
import { RentalBookingNotFoundError } from "./RentalBookings.js";
import type { RentalNotifications } from "./RentalNotifications.js";
import { RentalRateNotFoundError } from "./RentalRateAdministration.js";

export const BOOKING_SOURCE = "rental_booking";
export const DEPOSIT_SOURCE = "rental_deposit";
const DEPOSIT_REFUND_SOURCE = "rental_deposit_refund";

/** Money as the counter takes it (amounts as decimal text, "250.00"). */
export type CounterMoney = Readonly<{
  amount: string;
  method: PaymentMethod;
  momoNetwork?: "mtn" | "telecel" | "at" | null;
  reference?: string | null;
  paidOn?: string;
}>;

export type InvoiceSummary = Readonly<{
  id: string;
  number: string | null;
  status: string;
  issueDate: string;
  dueDate: string;
  total: MoneyJson;
  paid: MoneyJson;
  balance: MoneyJson;
}>;

export type DepositView = Readonly<{
  status: DepositStatus;
  paymentId: string;
  amount: MoneyJson;
  applied: MoneyJson;
  refunded: MoneyJson;
  held: MoneyJson;
  refundPaymentId: string | null;
}>;

export type BookingAccount = Readonly<{
  bookingId: string;
  currency: string;
  /** All the booking's charges. */
  charged: MoneyJson;
  /** Charges not yet on an invoice. */
  uninvoiced: MoneyJson;
  invoices: readonly InvoiceSummary[];
  /** Invoiced and not yet paid, plus what is not invoiced yet. */
  balance: MoneyJson;
  /** Payments for the booking not yet allocated (applied to the next invoice). */
  credit: MoneyJson;
  /** The deposit the class asks for (none on account). */
  depositRequired: MoneyJson | null;
  deposit: DepositView | null;
}>;

export type RenterSummary = Readonly<{
  customer: Pick<Renter, "id" | "name" | "type" | "riskStatus" | "riskReason" | "hasIdDocument">;
  onAccount: boolean;
  creditLimit: MoneyJson | null;
  paymentTermsDays: number | null;
  /** Open invoices plus booking charges not yet invoiced. */
  owed: MoneyJson;
  available: MoneyJson | null;
  history: Omit<RenterHistory, "chargedMinor"> & Readonly<{ charged: MoneyJson }>;
  authorisedDrivers: readonly Pick<Renter, "id" | "name" | "licenceNumber" | "licenceExpiresOn">[];
}>;

type Deps = Readonly<{
  unitOfWork: IUnitOfWork;
  bookings: IRentalBookings;
  invoicing: Invoicing;
  invoices: IInvoiceRepository;
  payments: PaymentRecording;
  posting: LedgerPosting;
  organisation: IOrganisationSettings;
  calendar: TenantCalendar;
  vehicleAccess: VehicleAccess;
  policy: AuthorizationPolicy;
  classDeposit: (classId: string | null) => Promise<number | null>;
  /** Receipts and invoices told to the customer (P5-7). */
  notifications?: RentalNotifications;
  ids: IIdGenerator;
  clock: { now(): Date };
}>;

/**
 * A rental's money and the renter's account (docs/07 §5, §8): the booking's charges invoiced
 * through finance, payments and the security deposit recorded through finance (record-only,
 * decision 16), corporate accounts with credit limits and authorised drivers (decisions 352–361).
 */
export class RentalAccounts {
  constructor(private readonly deps: Deps) {}

  // --- the booking's account ---

  account(actor: Principal, bookingId: string): Promise<BookingAccount> {
    return this.deps.unitOfWork.run(async () =>
      this.accountOf(await this.reach(actor, bookingId, "rentals.view")),
    );
  }

  /** Invoices what is not yet invoiced (a later damage, a cancellation fee). */
  invoiceNow(actor: Principal, bookingId: string): Promise<BookingAccount> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const booking = await this.reach(actor, bookingId, "rentals.update", true);
      if (booking.isUpcoming() || booking.status === "checked_out")
        throw new RentalBookingError("A booking is invoiced once the vehicle is back or it ended");
      if ((await this.invoice(actor, booking)) === null)
        throw new RentalBookingError("Nothing to invoice: the charges are invoiced already");
      return this.accountOf(booking);
    });
  }

  /** A payment for the booking: it pays the booking's open invoices, the rest waits for the next. */
  recordPayment(actor: Principal, bookingId: string, money: CounterMoney): Promise<BookingAccount> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const booking = await this.reach(actor, bookingId, "rentals.payments.record", true);
      const b = booking.snapshot();
      if (b.status === "cancelled" || b.status === "no_show")
        throw new RentalBookingError("Record payments of a cancelled booking in finance");
      const payment = await deps.payments.record(
        actor,
        {
          direction: "in",
          method: money.method,
          partyType: "customer",
          partyId: b.customerId,
          branchId: b.branchId,
          currency: b.currency,
          amount: money.amount,
          ...(money.paidOn === undefined ? {} : { paidOn: money.paidOn }),
          reference: money.reference ?? null,
          momoNetwork: money.momoNetwork ?? null,
          notes: `Rental ${b.number}`,
          source: { type: BOOKING_SOURCE, id: b.id },
        },
        "rentals.payments.record",
      );
      await this.event(booking, "payment_recorded", actor, {
        paymentId: payment.id,
        number: payment.number,
        amountMinor: payment.amount.amountMinor,
      });
      await this.settlePrepayments(actor, booking);
      const account = await this.accountOf(booking);
      await deps.notifications?.paymentReceived(booking, {
        paymentId: payment.id,
        number: payment.number,
        amountMinor: payment.amount.amountMinor,
        deposit: false,
        balanceMinor: account.balance.amountMinor,
      });
      return account;
    });
  }

  /** The security deposit taken (docs/07 §5): kept as the customer's credit, not revenue. */
  holdDeposit(actor: Principal, bookingId: string, money: CounterMoney): Promise<BookingAccount> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const booking = await this.reach(actor, bookingId, "rentals.payments.record", true);
      const b = booking.snapshot();
      if (!booking.isUpcoming() && b.status !== "checked_out")
        throw new RentalBookingError("The deposit is taken before or during the rental");
      if ((await deps.bookings.deposit(b.id)) !== null)
        throw new RentalBookingError("The booking has a deposit already");
      const payment = await deps.payments.record(
        actor,
        {
          direction: "in",
          method: money.method,
          partyType: "customer",
          partyId: b.customerId,
          branchId: b.branchId,
          currency: b.currency,
          amount: money.amount,
          ...(money.paidOn === undefined ? {} : { paidOn: money.paidOn }),
          reference: money.reference ?? null,
          momoNetwork: money.momoNetwork ?? null,
          notes: `Security deposit, rental ${b.number}`,
          source: { type: DEPOSIT_SOURCE, id: b.id },
        },
        "rentals.payments.record",
      );
      const deposit = RentalDeposit.hold({
        id: deps.ids.next(),
        bookingId: b.id,
        paymentId: payment.id,
        currency: b.currency,
        amountMinor: payment.amount.amountMinor,
        heldBy: actor.userId,
        now: deps.clock.now(),
      });
      await deps.bookings.saveDeposit(deposit);
      await this.event(booking, "deposit_held", actor, {
        paymentId: payment.id,
        amountMinor: payment.amount.amountMinor,
      });
      const account = await this.accountOf(booking);
      await deps.notifications?.paymentReceived(booking, {
        paymentId: payment.id,
        number: payment.number,
        amountMinor: payment.amount.amountMinor,
        deposit: true,
        balanceMinor: account.balance.amountMinor,
      });
      return account;
    });
  }

  /** Part of the deposit pays the booking's open invoices (all it can when no amount is given). */
  applyDeposit(
    actor: Principal,
    bookingId: string,
    amount: string | null,
  ): Promise<BookingAccount> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const booking = await this.reach(actor, bookingId, "rentals.payments.record", true);
      const b = booking.snapshot();
      const deposit = await deps.bookings.deposit(b.id, true);
      if (deposit === null) throw new RentalBookingError("The booking has no deposit");
      let left =
        amount === null
          ? deposit.heldMinor()
          : Math.min(Money.parse(amount, b.currency).amountMinor, deposit.heldMinor());
      if (amount !== null && Money.parse(amount, b.currency).amountMinor > deposit.heldMinor())
        throw new RentalBookingError("Apply up to what the deposit still holds");
      const now = deps.clock.now();
      let applied = 0;
      for (const invoice of await this.openInvoices(b.id)) {
        const share = Math.min(left, invoice.balanceMinor);
        if (share <= 0) continue;
        await deps.payments.allocateFor(actor, deposit.snapshot().paymentId, invoice.id, share);
        left -= share;
        applied += share;
      }
      if (applied === 0)
        throw new RentalBookingError("No invoice of the booking is waiting for payment");
      deposit.apply(applied, now);
      await deps.bookings.saveDeposit(deposit);
      await this.event(booking, "deposit_applied", actor, { amountMinor: applied });
      return this.accountOf(booking);
    });
  }

  /** What the deposit still holds goes back to the customer, once the rental is over. */
  releaseDeposit(
    actor: Principal,
    bookingId: string,
    refund: Omit<CounterMoney, "amount">,
  ): Promise<BookingAccount> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const booking = await this.reach(actor, bookingId, "rentals.payments.record", true);
      const b = booking.snapshot();
      if (booking.isUpcoming() || b.status === "checked_out")
        throw new RentalBookingError("The deposit is released once the vehicle is back");
      const deposit = await deps.bookings.deposit(b.id, true);
      if (deposit === null) throw new RentalBookingError("The booking has no deposit");
      const held = deposit.heldMinor();
      if (held === 0) throw new RentalBookingError("The deposit holds nothing to release");
      const payment = await deps.payments.record(
        actor,
        {
          direction: "out",
          method: refund.method,
          partyType: "customer",
          partyId: b.customerId,
          branchId: b.branchId,
          currency: b.currency,
          amount: Money.ofMinor(held, b.currency).toDecimalString(),
          ...(refund.paidOn === undefined ? {} : { paidOn: refund.paidOn }),
          reference: refund.reference ?? null,
          momoNetwork: refund.momoNetwork ?? null,
          notes: `Security deposit returned, rental ${b.number}`,
          source: { type: DEPOSIT_REFUND_SOURCE, id: b.id },
        },
        "rentals.payments.record",
      );
      deposit.release(payment.id, deps.clock.now());
      await deps.bookings.saveDeposit(deposit);
      await this.event(booking, "deposit_released", actor, {
        refundPaymentId: payment.id,
        amountMinor: held,
      });
      return this.accountOf(booking);
    });
  }

  // --- used by the booking lifecycle (inside its unit of work) ---

  /**
   * Issues an invoice for the booking's charges not yet invoiced and applies the booking's
   * payments to it. Null when there is nothing to bill.
   */
  async invoice(actor: Principal, booking: RentalBooking): Promise<string | null> {
    const { deps } = this;
    const b = booking.snapshot();
    const charges = (await deps.bookings.charges(b.id)).filter((c) => !given(c.invoiceId));
    if (charges.length === 0) return null;
    const tax = await deps.organisation.taxSettings();
    const draft = rentalInvoiceLines(charges, b.number, tax.pricesIncludeTax);
    // Charges that cancel out, or a credit waiting for later charges: nothing to bill.
    if (draft.lines.length === 0) return null;
    const renter = await deps.bookings.renter(b.customerId);
    const today = await deps.calendar.today();
    const terms = renter?.creditLimitMinor !== null ? (renter?.paymentTermsDays ?? null) : null;
    const accounts = await deps.posting.accounts();
    const registered = tax.scheme !== "not_registered";
    const taxCode = registered ? (b.terms.plan.taxCode ?? tax.defaultSalesTaxCode) : null;
    const money = (minor: number) => Money.ofMinor(minor, b.currency).toDecimalString();
    const invoice = await deps.invoicing.issueFor(actor, {
      partyType: "customer",
      partyId: b.customerId,
      branchId: b.branchId,
      vehicleId: b.vehicleId,
      currency: b.currency,
      issueDate: today,
      // On account: the customer's payment terms; otherwise due at once.
      dueDate: terms === null ? today : TenantCalendar.addDays(today, terms),
      notes: `Rental ${b.number}`,
      lines: draft.lines.map((line) => ({
        description: line.description,
        quantity: 1,
        unitPrice: money(line.amountMinor),
        discount: money(line.discountMinor),
        taxCode: line.taxed ? taxCode : null,
        accountId: accounts(line.kind === "damage" ? "other_income" : "rental_income"),
        vehicleId: b.vehicleId,
      })),
      source: { type: BOOKING_SOURCE, id: b.id },
    });
    await deps.bookings.markInvoiced(draft.chargeIds, invoice.id);
    await this.event(booking, "invoiced", actor, {
      invoiceId: invoice.id,
      number: invoice.number,
      totalMinor: invoice.total.amountMinor,
      heldBack: draft.heldBack.length,
    });
    await this.settlePrepayments(actor, booking);
    const issued = (await deps.invoices.findById(invoice.id))!.snapshot();
    await deps.notifications?.invoiced(booking, {
      invoiceId: invoice.id,
      number: issued.number ?? invoice.number ?? "",
      totalMinor: issued.totalMinor,
      balanceMinor: issued.totalMinor - issued.paidMinor,
      dueDate: issued.dueDate,
    });
    return invoice.id;
  }

  /**
   * A customer on account (a credit limit) may owe at most the limit: open invoices, charges not
   * yet invoiced and `addingMinor` (decision 357). Exceeding it needs `rentals.price.override`.
   */
  async assertCredit(
    actor: Principal,
    renter: Renter,
    addingMinor: number,
    branchId: string,
  ): Promise<void> {
    if (renter.creditLimitMinor === null || addingMinor <= 0) return;
    const exposure = await this.deps.bookings.exposure(renter.id);
    const owed = exposure.openInvoicesMinor + exposure.uninvoicedMinor + addingMinor;
    if (owed <= renter.creditLimitMinor) return;
    if (this.deps.policy.decide(actor, "rentals.price.override", { branchId }).allowed) return;
    const currency = await this.deps.posting.baseCurrency();
    const m = (minor: number) => Money.ofMinor(minor, currency).format();
    throw new RentalBookingError(
      `${renter.name} would owe ${m(owed)}, over the credit limit of ${m(renter.creditLimitMinor)}`,
    );
  }

  /** The deposit the booking still needs before check-out (none on account). */
  async depositShortfall(booking: RentalBooking, renter: Renter): Promise<number> {
    const b = booking.snapshot();
    if (renter.creditLimitMinor !== null) return 0;
    const required = await this.deps.classDeposit(b.classId);
    if (required === null) return 0;
    const deposit = await this.deps.bookings.deposit(b.id);
    return Math.max(0, required - (deposit?.heldMinor() ?? 0));
  }

  /** The deposit payment was reversed in finance (payment reversal listener). */
  async depositPaymentReversed(paymentId: string): Promise<void> {
    const deposit = await this.deps.bookings.depositByPayment(paymentId);
    if (deposit === null) return;
    deposit.reversed(this.deps.clock.now());
    await this.deps.bookings.saveDeposit(deposit);
  }

  /** How a deposit payment shows on its receipt. */
  async depositPurpose(
    bookingId: string,
    paymentId: string,
  ): Promise<Readonly<{ description: string; settledMinor: number }> | null> {
    const deposit = await this.deps.bookings.deposit(bookingId);
    const booking = await this.deps.bookings.get(bookingId);
    if (deposit === null || booking === null || deposit.snapshot().paymentId !== paymentId)
      return null;
    // The whole deposit is accounted for by the booking (held, applied or returned).
    return {
      description: `Security deposit, rental ${booking.snapshot().number}`,
      settledMinor: deposit.snapshot().amountMinor - deposit.snapshot().appliedMinor,
    };
  }

  // --- the renter ---

  renterSummary(actor: Principal, customerId: string): Promise<RenterSummary> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      deps.policy.require(actor, "customers.view");
      const renter = await deps.bookings.renter(customerId);
      if (renter === null) throw new RentalRateNotFoundError("Customer");
      const currency = await deps.posting.baseCurrency();
      const m = (minor: number) => Money.ofMinor(minor, currency).toJSON();
      const exposure = await deps.bookings.exposure(customerId);
      const owed = exposure.openInvoicesMinor + exposure.uninvoicedMinor;
      const { chargedMinor, ...history } = await deps.bookings.history(customerId);
      return {
        customer: {
          id: renter.id,
          name: renter.name,
          type: renter.type,
          riskStatus: renter.riskStatus,
          riskReason: renter.riskReason,
          hasIdDocument: renter.hasIdDocument,
        },
        onAccount: renter.creditLimitMinor !== null,
        creditLimit: renter.creditLimitMinor === null ? null : m(renter.creditLimitMinor),
        paymentTermsDays: renter.paymentTermsDays,
        owed: m(owed),
        available:
          renter.creditLimitMinor === null ? null : m(Math.max(0, renter.creditLimitMinor - owed)),
        history: { ...history, charged: m(chargedMinor) },
        authorisedDrivers: (await deps.bookings.authorisedDrivers(customerId)).map((d) => ({
          id: d.id,
          name: d.name,
          licenceNumber: d.licenceNumber,
          licenceExpiresOn: d.licenceExpiresOn,
        })),
      };
    });
  }

  /** An individual customer who may drive the company's rentals (docs/07 §8). */
  authoriseDriver(actor: Principal, corporateId: string, driverId: string): Promise<RenterSummary> {
    const { deps } = this;
    return deps.unitOfWork
      .run(async () => {
        deps.policy.require(actor, "customers.update");
        const company = await deps.bookings.renter(corporateId);
        const driver = await deps.bookings.renter(driverId);
        if (company === null || driver === null) throw new RentalRateNotFoundError("Customer");
        if (company.type !== "corporate")
          throw new RentalBookingError("Only a corporate customer has authorised drivers");
        if (driver.type !== "individual")
          throw new RentalBookingError("An authorised driver is an individual customer");
        await deps.bookings.addAuthorisedDriver(corporateId, driverId, actor.userId);
      })
      .then(() => this.renterSummary(actor, corporateId));
  }

  revokeDriver(actor: Principal, corporateId: string, driverId: string): Promise<RenterSummary> {
    const { deps } = this;
    return deps.unitOfWork
      .run(async () => {
        deps.policy.require(actor, "customers.update");
        if (!(await deps.bookings.removeAuthorisedDriver(corporateId, driverId)))
          throw new RentalRateNotFoundError("Authorised driver");
      })
      .then(() => this.renterSummary(actor, corporateId));
  }

  // --- helpers ---

  /** The booking's payments not yet used pay its open invoices, oldest first. */
  private async settlePrepayments(actor: Principal, booking: RentalBooking): Promise<void> {
    const { deps } = this;
    const invoices = await this.openInvoices(booking.id);
    for (const prepayment of await deps.bookings.prepayments(booking.id)) {
      let left = prepayment.unallocatedMinor;
      for (const invoice of invoices) {
        const share = Math.min(left, invoice.balanceMinor);
        if (share <= 0) continue;
        await deps.payments.allocateFor(actor, prepayment.paymentId, invoice.id, share);
        invoice.balanceMinor -= share;
        left -= share;
      }
    }
  }

  private async openInvoices(bookingId: string): Promise<{ id: string; balanceMinor: number }[]> {
    const open: { id: string; balanceMinor: number }[] = [];
    for (const id of await this.deps.bookings.invoiceIds(bookingId)) {
      const p = (await this.deps.invoices.findById(id))!.snapshot();
      if (p.status === "issued" || p.status === "partially_paid")
        open.push({ id, balanceMinor: p.totalMinor - p.paidMinor });
    }
    return open;
  }

  private async accountOf(booking: RentalBooking): Promise<BookingAccount> {
    const { deps } = this;
    const b = booking.snapshot();
    const m = (minor: number) => Money.ofMinor(minor, b.currency).toJSON();
    const charges = await deps.bookings.charges(b.id);
    const charged = charges.reduce((s, c) => s + c.totalMinor, 0);
    const uninvoiced = charges
      .filter((c) => !given(c.invoiceId))
      .reduce((s, c) => s + c.totalMinor, 0);
    const invoices: InvoiceSummary[] = [];
    let open = 0;
    for (const id of await deps.bookings.invoiceIds(b.id)) {
      const p = (await deps.invoices.findById(id))!.snapshot();
      if (p.status !== "void") open += p.totalMinor - p.paidMinor;
      invoices.push({
        id: p.id,
        number: p.number,
        status: p.status,
        issueDate: p.issueDate,
        dueDate: p.dueDate,
        total: m(p.totalMinor),
        paid: m(p.paidMinor),
        balance: m(p.totalMinor - p.paidMinor),
      });
    }
    const credit = (await deps.bookings.prepayments(b.id)).reduce(
      (s, p) => s + p.unallocatedMinor,
      0,
    );
    const renter = await deps.bookings.renter(b.customerId);
    const required =
      renter === null || renter.creditLimitMinor !== null
        ? null
        : await deps.classDeposit(b.classId);
    const deposit = await deps.bookings.deposit(b.id);
    const d = deposit?.snapshot();
    return {
      bookingId: b.id,
      currency: b.currency,
      charged: m(charged),
      uninvoiced: m(uninvoiced),
      invoices,
      balance: m(open + uninvoiced - credit),
      credit: m(credit),
      depositRequired: required === null ? null : m(required),
      deposit:
        d === undefined
          ? null
          : {
              status: d.status,
              paymentId: d.paymentId,
              amount: m(d.amountMinor),
              applied: m(d.appliedMinor),
              refunded: m(d.refundedMinor),
              held: m(deposit!.heldMinor()),
              refundPaymentId: d.refundPaymentId,
            },
    };
  }

  private async reach(
    actor: Principal,
    id: string,
    permission: PermissionKey,
    lock = false,
  ): Promise<RentalBooking> {
    const { deps } = this;
    const booking = lock ? await deps.bookings.lock(id) : await deps.bookings.get(id);
    if (
      booking === null ||
      !deps.vehicleAccess.can(actor, "rentals.view", booking.snapshot().branchId)
    )
      throw new RentalBookingNotFoundError();
    if (!deps.policy.decide(actor, permission, { branchId: booking.snapshot().branchId }).allowed)
      throw new PermissionDeniedError(permission);
    return booking;
  }

  private async event(
    booking: RentalBooking,
    type: BookingEventType,
    actor: Principal,
    data: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.deps.bookings.addEvent({
      id: this.deps.ids.next(),
      bookingId: booking.id,
      type,
      at: this.deps.clock.now(),
      actorId: actor.userId,
      data,
    });
  }
}

const given = <T>(value: T | null | undefined): value is T => value !== undefined && value !== null;
