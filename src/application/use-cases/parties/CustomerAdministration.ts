import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import {
  Customer,
  type CustomerDetails,
  type CustomerProps,
  type RiskStatus,
} from "../../../domain/parties/Customer.js";
import { maskGhanaCard } from "../../../domain/parties/PartyDetails.js";
import type { ICustomerRepository } from "../../../domain/repositories/IPartyRepositories.js";
import type { AuthorizationPolicy } from "../../authorization/AuthorizationPolicy.js";
import type { Principal } from "../../authorization/Principal.js";
import type { Page } from "../../dto/Page.js";
import { CustomerNotFoundError, PartyExistsError } from "../../errors/PartyErrors.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type {
  CustomerListFilter,
  ICustomerQueries,
  IPartyStatusHistory,
  PartyStatusEntry,
} from "../../ports/IPartyRecords.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { PageCursor } from "../../services/PageCursor.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import { recordUserAction } from "../reference/userAudit.js";

export type CustomerView = Omit<CustomerProps, "deletedAt" | "deletedReason" | "creditLimitMinor"> &
  Readonly<{ creditLimit: MoneyJson | null }>;

/** As sent by clients: the credit limit as a decimal string in the base currency. */
export type CustomerInput = Partial<Omit<CustomerDetails, "creditLimitMinor">> &
  Readonly<{ creditLimit?: string | null }>;

export type CustomerQuery = Omit<CustomerListFilter, "after" | "limit"> &
  Readonly<{ limit: number; cursor?: string }>;

const EMPTY: CustomerDetails = Object.freeze({
  type: "individual",
  firstName: null,
  lastName: null,
  companyName: null,
  phone: null,
  altPhone: null,
  email: null,
  address: null,
  dateOfBirth: null,
  occupation: null,
  ghanaCardNumber: null,
  licenceNumber: null,
  licenceClass: null,
  licenceExpiresOn: null,
  registrationNumber: null,
  tin: null,
  contactPerson: null,
  creditLimitMinor: null,
  paymentTermsDays: null,
  source: null,
  homeBranchId: null,
  tags: [],
  notes: null,
});

/**
 * Customers (docs/05 §2.2, docs/07 KYC): individuals and companies shared by every branch, with
 * KYC details, corporate credit terms and a risk status (watch / blacklisted) that follows them
 * everywhere. Ghana Card numbers are masked without `customers.id_documents.view`.
 */
export class CustomerAdministration {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      customers: ICustomerRepository;
      queries: ICustomerQueries;
      history: IPartyStatusHistory;
      organisation: IOrganisationSettings;
      policy: AuthorizationPolicy;
      numbering: DocumentNumbering;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  async list(actor: Principal, query: CustomerQuery): Promise<Page<CustomerView>> {
    const { deps } = this;
    const after = query.cursor === undefined ? undefined : PageCursor.parse(query.cursor, 2).values;
    return deps.unitOfWork.run(async () => {
      const rows = await deps.queries.list({
        ...query,
        limit: query.limit + 1,
        ...(after === undefined
          ? {}
          : { after: { createdAt: String(after[0]), id: String(after[1]) } }),
      });
      const currency = await this.currency();
      const page = PageCursor.paginate(rows, query.limit, (c) => [c.createdAt.toISOString(), c.id]);
      return { ...page, items: page.items.map((c) => this.view(actor, c, currency)) };
    });
  }

  async get(actor: Principal, id: string): Promise<CustomerView> {
    return this.deps.unitOfWork.run(async () =>
      this.view(actor, (await this.find(id)).snapshot(), await this.currency()),
    );
  }

  async create(actor: Principal, input: CustomerInput): Promise<CustomerView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const now = deps.clock.now();
      const currency = await this.currency();
      const customer = Customer.register({
        id: deps.ids.next(),
        code: await deps.numbering.next("customer", now),
        details: { ...EMPTY, ...this.details(input, null, currency) },
        createdBy: actor.userId,
        now,
      });
      await this.assertUnique(customer);
      await deps.customers.save(customer);
      await recordUserAction(deps, actor.userId, {
        action: "customer.created",
        entityType: "customer",
        entityId: customer.id,
        after: masked(customer.snapshot()),
      });
      return this.view(actor, customer.snapshot(), currency);
    });
  }

  async update(actor: Principal, id: string, input: CustomerInput): Promise<CustomerView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const customer = await this.find(id, true);
      const before = customer.snapshot();
      const currency = await this.currency();
      customer.update(this.details(input, before.creditLimitMinor, currency), deps.clock.now());
      await this.assertUnique(customer);
      await deps.customers.save(customer);
      await recordUserAction(deps, actor.userId, {
        action: "customer.updated",
        entityType: "customer",
        entityId: id,
        before: masked(before),
        after: masked(customer.snapshot()),
      });
      return this.view(actor, customer.snapshot(), currency);
    });
  }

  /** Watch, blacklist or clear a customer (with a reason, kept in the history). */
  async setRisk(
    actor: Principal,
    id: string,
    status: RiskStatus,
    reason: string,
  ): Promise<CustomerView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const customer = await this.find(id, true);
      const now = deps.clock.now();
      const from = customer.setRisk(status, reason, now);
      await deps.customers.save(customer);
      await deps.history.record({
        partyType: "customer",
        partyId: id,
        from,
        to: status,
        reason,
        changedBy: actor.userId,
        at: now,
      });
      await recordUserAction(deps, actor.userId, {
        action: `customer.risk_${status}`,
        entityType: "customer",
        entityId: id,
        before: { riskStatus: from },
        after: { riskStatus: status },
        metadata: { reason },
      });
      return this.view(actor, customer.snapshot(), await this.currency());
    });
  }

  async riskHistory(id: string): Promise<PartyStatusEntry[]> {
    return this.deps.unitOfWork.run(async () => {
      await this.find(id);
      return this.deps.history.list("customer", id);
    });
  }

  async remove(actor: Principal, id: string, reason: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const customer = await this.find(id, true);
      customer.remove(reason, deps.clock.now());
      await deps.customers.save(customer);
      await recordUserAction(deps, actor.userId, {
        action: "customer.removed",
        entityType: "customer",
        entityId: id,
        before: { code: customer.snapshot().code, name: customer.snapshot().name },
        metadata: { reason },
      });
    });
  }

  /** The customer (call inside a unit of work); used by documents, rentals and sales. */
  async find(id: string, lock = false): Promise<Customer> {
    const customer = lock
      ? await this.deps.customers.lockById(id)
      : await this.deps.customers.findById(id);
    if (customer === null) throw new CustomerNotFoundError();
    return customer;
  }

  private view(actor: Principal, p: CustomerProps, currency: string): CustomerView {
    const { deletedAt: _d, deletedReason: _r, creditLimitMinor, ...rest } = p;
    const sensitive = this.deps.policy.decide(actor, "customers.id_documents.view").allowed;
    return {
      ...rest,
      ghanaCardNumber:
        sensitive || rest.ghanaCardNumber === null
          ? rest.ghanaCardNumber
          : maskGhanaCard(rest.ghanaCardNumber),
      creditLimit:
        creditLimitMinor === null ? null : Money.ofMinor(creditLimitMinor, currency).toJSON(),
    };
  }

  private details(
    input: CustomerInput,
    currentLimit: number | null,
    currency: string,
  ): Partial<CustomerDetails> {
    const { creditLimit, ...rest } = input;
    const details: Partial<CustomerDetails> = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    );
    const creditLimitMinor =
      creditLimit === undefined
        ? currentLimit
        : creditLimit === null
          ? null
          : Money.parse(creditLimit, currency).amountMinor;
    return { ...details, creditLimitMinor };
  }

  private async currency(): Promise<string> {
    return (await this.deps.organisation.currencySettings()).baseCurrency;
  }

  private async assertUnique(customer: Customer): Promise<void> {
    const p = customer.snapshot();
    if (p.email !== null && (await this.deps.customers.emailTaken(p.email, p.id)))
      throw new PartyExistsError(`Another customer already has the email ${p.email}`);
    if (
      p.ghanaCardNumber !== null &&
      (await this.deps.customers.ghanaCardTaken(p.ghanaCardNumber, p.id))
    )
      throw new PartyExistsError("Another customer already has this Ghana Card number");
  }
}

/** Audit entries never carry full Ghana Card numbers. */
function masked(p: CustomerProps): CustomerProps {
  return p.ghanaCardNumber === null
    ? p
    : { ...p, ghanaCardNumber: maskGhanaCard(p.ghanaCardNumber) };
}
