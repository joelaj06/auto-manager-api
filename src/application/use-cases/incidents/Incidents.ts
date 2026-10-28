import { credit, debit, journal } from "../../../domain/finance/Journal.js";
import { METHOD_ACCOUNT } from "../../../domain/finance/Payment.js";
import {
  INCIDENT_STATUS,
  Incident,
  IncidentRuleError,
  InsuranceClaim,
  type ClaimProps,
  type ClaimStatus,
  type IncidentDetails,
  type IncidentProps,
  type IncidentSeverity,
  type IncidentType,
  type SettlementMethod,
  type ThirdParty,
} from "../../../domain/incidents/Incident.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import {
  FINAL_STATUSES,
  MODULE_STATUSES,
  nextStatuses,
  type VehicleStatus,
} from "../../../domain/vehicles/VehicleStatus.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IIncidents, IncidentCosts } from "../../ports/IIncidents.js";
import type { INotificationSettingsStore } from "../../ports/INotifications.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { Notifier } from "../notifications/Notifier.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { VehicleDamages } from "../rentals/VehicleDamages.js";
import type { VehicleAccess } from "../vehicles/VehicleAccess.js";
import type { VehicleIssues } from "../vehicles/VehicleIssues.js";
import type { VehicleRegistry } from "../vehicles/VehicleRegistry.js";

export class IncidentNotFoundError extends ApplicationError {
  readonly code = "INCIDENT_NOT_FOUND";
  constructor() {
    super("Incident not found");
  }
}

export class ClaimNotFoundError extends ApplicationError {
  readonly code = "CLAIM_NOT_FOUND";
  constructor() {
    super("Insurance claim not found");
  }
}

type ThirdPartyInput = Readonly<{
  name: string;
  phone?: string | null;
  plateNumber?: string | null;
  insurer?: string | null;
  policyNo?: string | null;
  notes?: string | null;
}>;

export type IncidentInput = Readonly<{
  type: IncidentType;
  severity?: IncidentSeverity;
  occurredAt: Date;
  location?: string | null;
  description: string;
  injuries?: boolean;
  policeReportNo?: string | null;
  policeStation?: string | null;
  thirdParties?: readonly ThirdPartyInput[];
  /** Default: the driver of the vehicle's assignment when it happened. */
  driverId?: string | null;
}>;

export type ReportInput = IncidentInput &
  Readonly<{
    vehicleId: string;
    issueId?: string | null;
    damageId?: string | null;
    /**
     * Put the vehicle in the incident's status (accident, stolen, impounded). Default: yes for a
     * theft, an impound and an accident that is not minor.
     */
    moveVehicle?: boolean;
  }>;

export type ClaimView = Omit<
  ClaimProps,
  "claimedMinor" | "excessMinor" | "approvedMinor" | "settledMinor"
> &
  Readonly<{
    claimed: MoneyJson;
    excess: MoneyJson;
    approved: MoneyJson | null;
    settled: MoneyJson | null;
    expected: MoneyJson;
  }>;

export type IncidentView = IncidentProps &
  Readonly<{
    claims: readonly ClaimView[];
    costs: Readonly<{
      workOrders: readonly (Omit<IncidentCosts["workOrders"][number], `${string}Minor`> &
        Readonly<{ total: MoneyJson; company: MoneyJson; driver: MoneyJson }>)[];
      expenses: readonly (Omit<IncidentCosts["expenses"][number], "amountMinor"> &
        Readonly<{ amount: MoneyJson }>)[];
      /** Repairs and expenses the business bears, before recoveries. */
      business: MoneyJson;
      /** Charged to the driver (their work order shares and expenses). */
      driver: MoneyJson;
      /** Charged to the renter. */
      customer: MoneyJson;
      /** Received from insurers. */
      recovered: MoneyJson;
      /** Still expected from insurers (submitted and approved claims). */
      expected: MoneyJson;
      /** What the incident cost the business so far: its share less what insurers paid. */
      net: MoneyJson;
    }>;
  }>;

const POSTED = new Set(["approved", "paid"]);

/**
 * Incidents (docs/06 §8): accidents, thefts, impounds and other harm to a vehicle, the driver who
 * had it, the police report and others involved; the vehicle put in the incident's status and
 * back on closing; its work orders and expenses as its cost; and insurance claims recovering part
 * of it, the money received posted to insurance recoveries (decisions 396–400).
 */
export class Incidents {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      incidents: IIncidents;
      vehicles: IVehicleRepository;
      vehicleAccess: VehicleAccess;
      registry: VehicleRegistry;
      issues: VehicleIssues;
      damages: VehicleDamages;
      posting: LedgerPosting;
      numbering: DocumentNumbering;
      organisation: IOrganisationSettings;
      settings: INotificationSettingsStore;
      notifier: Notifier;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: { now(): Date };
    }>,
  ) {}

  list(
    actor: Principal,
    query: Readonly<{
      vehicleId?: string;
      driverId?: string;
      type?: IncidentType;
      status?: "open" | "closed";
      before?: string;
      limit: number;
    }>,
  ): Promise<IncidentProps[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const found = await deps.incidents.list({
        branchIds: deps.vehicleAccess.branchesFor(actor, "incidents.view"),
        ...(query.vehicleId === undefined ? {} : { vehicleId: query.vehicleId }),
        ...(query.driverId === undefined ? {} : { driverId: query.driverId }),
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.before === undefined ? {} : { beforeId: query.before }),
        limit: query.limit,
      });
      return found.map((i) => i.snapshot());
    });
  }

  get(actor: Principal, id: string): Promise<IncidentView> {
    return this.deps.unitOfWork.run(async () =>
      this.view(await this.reach(actor, id, "incidents.view")),
    );
  }

  report(actor: Principal, input: ReportInput): Promise<IncidentView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const vehicle = await deps.vehicleAccess.reach(
        actor,
        input.vehicleId,
        "incidents.manage",
        true,
      );
      const now = deps.clock.now();
      if (input.issueId !== undefined && input.issueId !== null)
        await deps.issues.takenOn(input.issueId, vehicle.id, actor.userId);
      if (input.damageId !== undefined && input.damageId !== null)
        await deps.damages.forWorkOrder(input.damageId, vehicle.id);
      const incident = Incident.report({
        id: deps.ids.next(),
        number: await deps.numbering.next("incident", now),
        vehicleId: vehicle.id,
        branchId: vehicle.branchId,
        ...(await this.details(input, vehicle.id)),
        issueId: input.issueId ?? null,
        damageId: input.damageId ?? null,
        createdBy: actor.userId,
        now,
      });
      const p = incident.snapshot();
      const target = INCIDENT_STATUS[p.type];
      const move =
        input.moveVehicle ??
        (p.type === "theft" ||
          p.type === "impound" ||
          (p.type === "accident" && p.severity !== "minor"));
      if (move && target !== undefined) {
        const from = vehicle.status;
        // A vehicle held by an assignment, a rental, Work & Pay or a sale stays with that module.
        if (!MODULE_STATUSES.has(from) && !FINAL_STATUSES.has(from) && from !== target) {
          await deps.registry.moveByModule(vehicle, target, {
            ref: { type: "incident", id: p.id },
            reason: `Incident ${p.number}: ${p.description}`.slice(0, 500),
            userId: actor.userId,
          });
          incident.movedVehicle(target, from, now);
        }
      }
      await deps.incidents.insert(incident);
      await this.alert(incident, vehicle.snapshot().plateNumber ?? vehicle.snapshot().code);
      await this.audit(actor, "incident.reported", incident, null);
      return this.view(incident);
    });
  }

  change(actor: Principal, id: string, input: Partial<IncidentInput>): Promise<IncidentView> {
    return this.mutate(actor, id, "incident.changed", async (incident, now) => {
      const p = incident.snapshot();
      const merged: IncidentInput = {
        ...p,
        ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
      };
      incident.change(await this.details(merged, p.vehicleId, p.driverId), now);
    });
  }

  /** Closed with its outcome; a vehicle the incident moved goes back if it is still there. */
  close(actor: Principal, id: string, outcome: string): Promise<IncidentView> {
    return this.mutate(actor, id, "incident.closed", async (incident, now) => {
      incident.close(outcome, actor.userId, now);
      const p = incident.snapshot();
      if (p.vehicleStatus === null || p.statusBefore === null) return;
      const vehicle = (await this.deps.vehicles.lockById(p.vehicleId))!;
      const before = p.statusBefore as VehicleStatus;
      if (vehicle.status !== p.vehicleStatus || !nextStatuses(vehicle.status).includes(before))
        return;
      await this.deps.registry.moveByModule(vehicle, before, {
        ref: { type: "incident", id: p.id },
        reason: `Incident ${p.number} closed`,
        userId: actor.userId,
      });
    });
  }

  reopen(actor: Principal, id: string): Promise<IncidentView> {
    return this.mutate(actor, id, "incident.reopened", (incident, now) => {
      incident.reopen(now);
      return Promise.resolve();
    });
  }

  /** A work order or an expense of the vehicle counted in the incident's cost. */
  link(
    actor: Principal,
    id: string,
    target: Readonly<{ workOrderId?: string; expenseId?: string }>,
  ): Promise<IncidentView> {
    return this.mutate(actor, id, "incident.linked", async (incident) => {
      const p = incident.snapshot();
      if (target.workOrderId !== undefined) {
        if (!(await this.deps.incidents.linkWorkOrder(p.id, target.workOrderId, p.vehicleId)))
          throw new IncidentRuleError("No work order of this vehicle has that id");
      }
      if (target.expenseId !== undefined) {
        if (!(await this.deps.incidents.linkExpense(p.id, target.expenseId, p.vehicleId)))
          throw new IncidentRuleError("No expense of this vehicle has that id");
      }
    });
  }

  // --- insurance claims ---

  claims(
    actor: Principal,
    query: Readonly<{ status?: ClaimStatus; insurerId?: string; limit: number }>,
  ): Promise<ClaimView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const claims = await deps.incidents.claims({
        branchIds: deps.vehicleAccess.branchesFor(actor, "incidents.view"),
        ...(query.status === undefined ? {} : { statuses: [query.status] }),
        ...(query.insurerId === undefined ? {} : { insurerId: query.insurerId }),
        limit: query.limit,
      });
      const currency = await this.currency();
      return claims.map((c) => claimView(c, currency));
    });
  }

  submitClaim(
    actor: Principal,
    incidentId: string,
    input: Readonly<{
      insurerId: string;
      policyNo?: string | null;
      claimNo?: string | null;
      claimed: string;
      excess?: string;
      submittedOn?: string;
      notes?: string | null;
    }>,
  ): Promise<IncidentView> {
    return this.mutate(actor, incidentId, "insurance_claim.submitted", async (incident, now) => {
      const { deps } = this;
      if (!(await deps.incidents.supplierExists(input.insurerId)))
        throw new IncidentRuleError("That insurer is not a supplier");
      const currency = await this.currency();
      const today = await deps.calendar.today();
      const submittedOn = input.submittedOn ?? today;
      if (submittedOn > today)
        throw new IncidentRuleError("A claim cannot be submitted later than today");
      const live = (await deps.incidents.claimsOf(incident.id)).find(
        (c) =>
          c.snapshot().insurerId === input.insurerId &&
          (c.snapshot().status === "submitted" || c.snapshot().status === "approved"),
      );
      if (live !== undefined)
        throw new IncidentRuleError("There is already a live claim on that insurer");
      await deps.incidents.insertClaim(
        InsuranceClaim.submit({
          id: deps.ids.next(),
          incidentId: incident.id,
          insurerId: input.insurerId,
          policyNo: input.policyNo ?? null,
          claimNo: input.claimNo ?? null,
          claimedMinor: Money.parse(input.claimed, currency).amountMinor,
          excessMinor:
            input.excess === undefined ? 0 : Money.parse(input.excess, currency).amountMinor,
          submittedOn,
          notes: input.notes ?? null,
          createdBy: actor.userId,
          now,
        }),
      );
    });
  }

  /** The insurer approved (an amount), rejected, the claim was withdrawn, or the money came. */
  decideClaim(
    actor: Principal,
    claimId: string,
    decision:
      | Readonly<{ action: "approve"; approved: string; claimNo?: string | null }>
      | Readonly<{ action: "reject"; reason: string }>
      | Readonly<{ action: "withdraw"; reason: string }>
      | Readonly<{
          action: "settle";
          amount: string;
          method: SettlementMethod;
          receivedOn?: string;
          reference?: string | null;
        }>,
  ): Promise<IncidentView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const claim = await deps.incidents.lockClaim(claimId);
      if (claim === null) throw new ClaimNotFoundError();
      const incident = await this.reach(actor, claim.snapshot().incidentId, "incidents.manage");
      const before = claim.snapshot();
      const now = deps.clock.now();
      const currency = await this.currency();
      if (decision.action === "approve")
        claim.approve(
          Money.parse(decision.approved, currency).amountMinor,
          decision.claimNo ?? null,
          now,
        );
      else if (decision.action === "reject") claim.reject(decision.reason, now);
      else if (decision.action === "withdraw") claim.withdraw(decision.reason, now);
      else {
        const today = await deps.calendar.today();
        const on = decision.receivedOn ?? today;
        if (on > today) throw new IncidentRuleError("The money cannot arrive later than today");
        claim.settle(
          {
            amountMinor: Money.parse(decision.amount, currency).amountMinor,
            on,
            method: decision.method,
            reference: decision.reference ?? null,
          },
          now,
        );
        await this.postRecovery(claim, incident, actor.userId);
      }
      await deps.incidents.updateClaim(claim);
      await recordUserAction(deps, actor.userId, {
        action: `insurance_claim.${decision.action === "approve" ? "approved" : decision.action === "reject" ? "rejected" : decision.action === "withdraw" ? "withdrawn" : "settled"}`,
        entityType: "insurance_claim",
        entityId: claimId,
        before: { status: before.status },
        after: {
          status: claim.snapshot().status,
          approvedMinor: claim.snapshot().approvedMinor,
          settledMinor: claim.snapshot().settledMinor,
        },
      });
      return this.view(incident);
    });
  }

  // --- helpers ---

  /** The money received: Dr the bank, mobile money or cheques, Cr insurance recoveries. */
  private async postRecovery(
    claim: InsuranceClaim,
    incident: Incident,
    userId: string,
  ): Promise<void> {
    const c = claim.snapshot();
    const i = incident.snapshot();
    const accounts = await this.deps.posting.accounts();
    const tags = { branchId: i.branchId, vehicleId: i.vehicleId, memo: c.settlementReference };
    await this.deps.posting.post(
      journal({
        date: c.settledOn!,
        description: `Insurance claim ${c.claimNo ?? ""} on incident ${i.number} settled`.replace(
          "  ",
          " ",
        ),
        source: { type: "insurance_claim", id: c.id },
        reversesId: null,
        lines: [
          debit(c.settledMinor!, {
            accountId: accounts(METHOD_ACCOUNT[c.settlementMethod!]),
            ...tags,
          }),
          credit(c.settledMinor!, {
            accountId: accounts("insurance_recoveries"),
            ...tags,
            party: { type: "supplier", id: c.insurerId },
          }),
        ],
      }),
      userId,
    );
  }

  private async details(
    input: IncidentInput,
    vehicleId: string,
    current: string | null = null,
  ): Promise<IncidentDetails> {
    const { deps } = this;
    let driverId: string | null;
    if (input.driverId === undefined)
      driverId =
        current ?? (await deps.incidents.driverAt(vehicleId, input.occurredAt))?.driverId ?? null;
    else if (input.driverId === null) driverId = null;
    else {
      if ((await deps.incidents.driver(input.driverId)) === null)
        throw new IncidentRuleError("That driver does not exist");
      driverId = input.driverId;
    }
    return {
      driverId,
      type: input.type,
      severity: input.severity ?? "minor",
      occurredAt: input.occurredAt,
      location: input.location ?? null,
      description: input.description,
      injuries: input.injuries ?? false,
      policeReportNo: input.policeReportNo ?? null,
      policeStation: input.policeStation ?? null,
      thirdParties: (input.thirdParties ?? []).map((t): ThirdParty => ({
        name: t.name,
        phone: t.phone ?? null,
        plateNumber: t.plateNumber ?? null,
        insurer: t.insurer ?? null,
        policyNo: t.policyNo ?? null,
        notes: t.notes ?? null,
      })),
    };
  }

  private async alert(incident: Incident, vehicle: string): Promise<void> {
    const { deps } = this;
    const settings = await deps.settings.get();
    if (!settings.rules.incident_reported.enabled) return;
    const p = incident.snapshot();
    const serious = p.injuries || p.severity === "total_loss" || p.type === "theft";
    await deps.notifier.staff(settings, {
      rule: "incident_reported",
      permission: "incidents.view",
      branchId: p.branchId,
      dedupeKey: `incident_reported:${p.id}`,
      title: `${vehicle}: ${p.type.replace("_", " ")} reported (${p.number})`,
      body: `${p.description}${p.location === null ? "" : ` — ${p.location}`}.${p.injuries ? " People were injured." : ""}`,
      severity: serious ? "critical" : "warning",
      data: { incidentId: p.id, vehicleId: p.vehicleId },
    });
  }

  private async mutate(
    actor: Principal,
    id: string,
    action: string,
    run: (incident: Incident, now: Date) => Promise<void>,
  ): Promise<IncidentView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const incident = await this.reach(actor, id, "incidents.manage", true);
      const before = incident.snapshot();
      await run(incident, deps.clock.now());
      await deps.incidents.update(incident);
      await this.audit(actor, action, incident, before);
      return this.view(incident);
    });
  }

  private async reach(
    actor: Principal,
    id: string,
    permission: "incidents.view" | "incidents.manage",
    lock = false,
  ): Promise<Incident> {
    const { deps } = this;
    const incident = lock ? await deps.incidents.lock(id) : await deps.incidents.get(id);
    if (
      incident === null ||
      !deps.vehicleAccess.can(actor, "incidents.view", incident.snapshot().branchId)
    )
      throw new IncidentNotFoundError();
    await deps.vehicleAccess.branch(actor, permission, incident.snapshot().branchId);
    return incident;
  }

  private async view(incident: Incident): Promise<IncidentView> {
    const { deps } = this;
    const p = incident.snapshot();
    const currency = await this.currency();
    const m = (minor: number) => Money.ofMinor(minor, currency).toJSON();
    const costs = await deps.incidents.costs(p.id);
    const claims = await deps.incidents.claimsOf(p.id);
    const done = costs.workOrders.filter((o) => o.status === "completed");
    const sum = <T>(rows: readonly T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0);
    const posted = costs.expenses.filter((e) => POSTED.has(e.status));
    const business =
      sum(done, (o) => o.companyMinor + o.insurerMinor) +
      sum(
        posted.filter((e) => !e.chargeToDriver),
        (e) => e.amountMinor,
      );
    const driver =
      sum(done, (o) => o.driverMinor) +
      sum(
        posted.filter((e) => e.chargeToDriver),
        (e) => e.amountMinor,
      );
    const recovered = sum(claims, (c) => c.snapshot().settledMinor ?? 0);
    const expected = sum(
      claims.filter(
        (c) => c.snapshot().status === "submitted" || c.snapshot().status === "approved",
      ),
      (c) => c.expectedMinor(),
    );
    return {
      ...p,
      claims: claims.map((c) => claimView(c, currency)),
      costs: {
        workOrders: costs.workOrders.map((o) => ({
          id: o.id,
          number: o.number,
          status: o.status,
          total: m(o.totalMinor),
          company: m(o.companyMinor + o.insurerMinor),
          driver: m(o.driverMinor),
        })),
        expenses: costs.expenses.map(({ amountMinor, ...e }) => ({ ...e, amount: m(amountMinor) })),
        business: m(business),
        driver: m(driver),
        customer: m(sum(done, (o) => o.customerMinor)),
        recovered: m(recovered),
        expected: m(expected),
        net: m(business - recovered),
      },
    };
  }

  private async currency(): Promise<string> {
    return (await this.deps.organisation.get()).baseCurrency;
  }

  private async audit(
    actor: Principal,
    action: string,
    incident: Incident,
    before: IncidentProps | null,
  ): Promise<void> {
    const summary = (i: IncidentProps) => ({
      number: i.number,
      type: i.type,
      severity: i.severity,
      status: i.status,
      driverId: i.driverId,
    });
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "incident",
      entityId: incident.id,
      before: before === null ? null : summary(before),
      after: { ...summary(incident.snapshot()), vehicleId: incident.snapshot().vehicleId },
    });
  }
}

function claimView(claim: InsuranceClaim, currency: string): ClaimView {
  const { claimedMinor, excessMinor, approvedMinor, settledMinor, ...rest } = claim.snapshot();
  const m = (minor: number) => Money.ofMinor(minor, currency).toJSON();
  return {
    ...rest,
    claimed: m(claimedMinor),
    excess: m(excessMinor),
    approved: approvedMinor === null ? null : m(approvedMinor),
    settled: settledMinor === null ? null : m(settledMinor),
    expected: m(claim.expectedMinor()),
  };
}
