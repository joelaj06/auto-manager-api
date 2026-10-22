import type {
  IGatewayRepository,
  ReconciliationRecord,
} from "../../../domain/repositories/IGatewayRepository.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { IClock } from "../../ports/IClock.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IPaymentGateway } from "../../ports/IPaymentGateway.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import { recordStaffAction } from "../console/consoleAudit.js";
import type { GatewayBilling } from "./GatewayBilling.js";

const DAY_MS = 86_400_000;

/**
 * The daily reconciliation (docs/25 §9): our gateway payments of a day (Africa/Accra, UTC+0)
 * against the provider's successful transactions. A payment the provider has but we never
 * applied (a lost webhook) is verified and applied first; what still differs — missing on either
 * side, or a different amount — makes the day `mismatched` and is logged as an error for the
 * on-call (the alerts centre comes with P4-7).
 */
export class GatewayReconciliation implements IJobHandler<"billing.reconcile"> {
  readonly job = "billing.reconcile" as const;

  constructor(
    private readonly deps: Readonly<{
      provider: IPaymentGateway;
      gateway: IGatewayRepository;
      payments: GatewayBilling;
      unitOfWork: IPlatformUnitOfWork;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  /** The scheduled run: yesterday. */
  async handle(): Promise<void> {
    const yesterday = new Date(this.deps.clock.now().getTime() - DAY_MS).toISOString().slice(0, 10);
    await this.run(yesterday);
  }

  /** A staff member runs a day again (console). */
  async runFor(day: string, actor: PlatformPrincipal): Promise<ReconciliationRecord> {
    const record = await this.run(day);
    await this.deps.unitOfWork.run(() =>
      recordStaffAction(this.deps, actor, {
        action: "billing.reconciliation_run",
        entityType: "gateway_reconciliation",
        entityId: record.id,
        after: { day, status: record.status },
      }),
    );
    return record;
  }

  list(limit: number): Promise<ReconciliationRecord[]> {
    return this.deps.gateway.reconciliations(limit);
  }

  async run(day: string): Promise<ReconciliationRecord> {
    const { deps } = this;
    const from = new Date(`${day}T00:00:00Z`);
    const to = new Date(from.getTime() + DAY_MS);
    const provider = deps.provider.provider;
    let theirs;
    try {
      theirs = await deps.provider.transactions({ from, to });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.error("Gateway reconciliation failed", { day, error: message });
      return deps.unitOfWork.run(() =>
        deps.gateway.saveReconciliation({
          provider,
          day,
          status: "failed",
          ourCount: 0,
          ourMinor: 0,
          providerCount: 0,
          providerMinor: 0,
          feesMinor: 0,
          missingHere: [],
          missingThere: [],
          amountMismatches: [],
          error: message,
        }),
      );
    }
    // A payment the provider has and we still wait for (a lost webhook): apply it now.
    for (const t of theirs) {
      const attempt = await deps.gateway.attempt(t.reference);
      if (attempt !== null && !attempt.isFinal)
        await deps.payments.apply(t.reference, await deps.provider.verify(t.reference));
    }
    const ours = (await deps.gateway.succeededBetween(provider, from, to)).map((a) => a.snapshot());
    const ourByRef = new Map(ours.map((a) => [a.reference, a]));
    const theirByRef = new Map(theirs.map((t) => [t.reference, t]));
    const missingHere = theirs
      .filter((t) => !ourByRef.has(t.reference))
      .map((t) => ({ reference: t.reference, amountMinor: t.amountMinor, paidAt: t.paidAt }));
    const missingThere = ours
      .filter((a) => !theirByRef.has(a.reference))
      .map((a) => ({ reference: a.reference, amountMinor: a.amountMinor, status: a.status }));
    const amountMismatches = ours
      .filter((a) => theirByRef.has(a.reference))
      .filter(
        (a) => theirByRef.get(a.reference)!.amountMinor !== a.amountMinor || a.status === "review",
      )
      .map((a) => ({
        reference: a.reference,
        ours: a.amountMinor,
        theirs: theirByRef.get(a.reference)!.amountMinor,
        status: a.status,
      }));
    const status =
      missingHere.length + missingThere.length + amountMismatches.length === 0
        ? "matched"
        : "mismatched";
    if (status === "mismatched")
      deps.logger.error("Gateway reconciliation mismatch", {
        day,
        missingHere: missingHere.length,
        missingThere: missingThere.length,
        amountMismatches: amountMismatches.length,
      });
    return deps.unitOfWork.run(() =>
      deps.gateway.saveReconciliation({
        provider,
        day,
        status,
        ourCount: ours.length,
        ourMinor: ours.reduce((sum, a) => sum + a.amountMinor, 0),
        providerCount: theirs.length,
        providerMinor: theirs.reduce((sum, t) => sum + t.amountMinor, 0),
        feesMinor: theirs.reduce((sum, t) => sum + (t.feesMinor ?? 0), 0),
        missingHere,
        missingThere,
        amountMismatches,
        error: null,
      }),
    );
  }
}
