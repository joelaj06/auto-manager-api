import {
  ApprovalRequest,
  type ApprovalRequestProps,
  type ApprovalStatus,
} from "../../../domain/entities/ApprovalRequest.js";
import type { IApprovalRequestRepository } from "../../../domain/repositories/IApprovalRequestRepository.js";
import { SUPER_ADMIN_ROLE } from "../../authorization/platformPermissionCatalog.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { ApprovalNotFoundError, StaffRuleViolationError } from "../../errors/StaffErrors.js";
import type { NotificationService } from "../../notifications/NotificationService.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformRoles } from "../../ports/IPlatformRoles.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";

/** What runs once a request is approved. Registered per action at startup. */
export type ApprovalExecutor = Readonly<{
  action: string;
  /** System role the approver must hold (docs/27 §8), e.g. super_admin; null: any approver. */
  approverSystemRole: string | null;
  execute(
    payload: Readonly<Record<string, unknown>>,
    context: Readonly<{ requestedBy: string; approvedBy: string; approvalId: string }>,
  ): Promise<Readonly<Record<string, unknown>>>;
}>;

export type ApprovalView = ApprovalRequestProps;

export type NewApprovalRequest = Readonly<{
  action: string;
  payload: Readonly<Record<string, unknown>>;
  summary: string;
  reason: string;
  ticket?: string | null;
  targetTenantId?: string | null;
  requestedBy: string;
}>;

/**
 * Four-eyes approvals (docs/27 §8). A request names an action with a registered executor; a
 * different staff member with `platform.approvals.approve` (and the executor's approver role, if
 * any) approves it, which runs the action in the same transaction behind a savepoint — a failing
 * action is recorded as `failed` without leaving partial changes. Requests expire after 24 h.
 */
export class ApprovalWorkflow {
  private readonly executors = new Map<string, ApprovalExecutor>();

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IPlatformUnitOfWork;
      approvals: IApprovalRequestRepository;
      roles: IPlatformRoles;
      audit: IPlatformAuditTrail;
      notifications: NotificationService;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      ttlMs: number;
    }>,
  ) {}

  register(executor: ApprovalExecutor): void {
    if (this.executors.has(executor.action)) {
      throw new Error(`Approval executor already registered: ${executor.action}`);
    }
    this.executors.set(executor.action, executor);
  }

  /** Opens a request (inside the caller's unit of work, if any) and notifies possible approvers. */
  async request(input: NewApprovalRequest): Promise<string> {
    const { deps } = this;
    const executor = this.executorFor(input.action);
    const request = ApprovalRequest.open({
      id: deps.ids.next(),
      ...input,
      now: deps.clock.now(),
      ttlMs: deps.ttlMs,
    });
    await deps.unitOfWork.run(async () => {
      await deps.approvals.save(request);
      await deps.audit.record({
        actorType: "platform_staff",
        actorId: input.requestedBy,
        action: "approval.requested",
        entityType: "approval_request",
        entityId: request.id,
        targetTenantId: input.targetTenantId ?? null,
        reason: input.reason,
        after: { action: input.action, summary: input.summary },
        ...this.meta(),
      });
    });

    const approvers = await deps.roles.activeUsersWithSystemRole(
      executor.approverSystemRole ?? SUPER_ADMIN_ROLE,
    );
    for (const approver of approvers.filter((a) => a.id !== input.requestedBy)) {
      await deps.notifications
        .sendEmail({
          to: approver.email,
          template: "platform.approval_requested",
          data: { requestedBy: input.requestedBy, summary: input.summary, reason: input.reason },
          idempotencyKey: `approval:${request.id}:${approver.id}`,
        })
        .catch(() => undefined);
    }
    return request.id;
  }

  async decide(
    id: string,
    decider: PlatformPrincipal,
    decision: "approve" | "reject",
    note: string | null,
  ): Promise<ApprovalView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const request = await deps.approvals.lockById(id);
      if (request === null) throw new ApprovalNotFoundError();
      const now = deps.clock.now();
      const executor = this.executorFor(request.action);

      // Expiry is evaluated here on every decision; nothing needs to sweep expired requests.
      request.assertDecidable(decider.userId, now);
      if (
        decision === "approve" &&
        executor.approverSystemRole !== null &&
        !decider.systemRoles.has(executor.approverSystemRole)
      ) {
        throw new StaffRuleViolationError(
          "APPROVER_ROLE_REQUIRED",
          `Only a ${executor.approverSystemRole} can approve this request`,
        );
      }

      if (decision === "reject") {
        request.reject(decider.userId, note, now);
      } else {
        const outcome = await deps.unitOfWork.attempt(() =>
          executor.execute(request.payload, {
            requestedBy: request.requestedBy,
            approvedBy: decider.userId,
            approvalId: request.id,
          }),
        );
        request.approveAndRecord(
          decider.userId,
          note,
          now,
          outcome.ok
            ? { ok: true, result: outcome.value }
            : {
                ok: false,
                error:
                  outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
              },
        );
      }
      await deps.approvals.save(request);
      const snapshot = request.snapshot();
      await deps.audit.record({
        actorType: "platform_staff",
        actorId: decider.userId,
        action: `approval.${snapshot.status}`,
        entityType: "approval_request",
        entityId: request.id,
        targetTenantId: snapshot.targetTenantId,
        reason: note,
        after: { action: snapshot.action, status: snapshot.status, error: snapshot.error },
        ...this.meta(),
      });
      return snapshot;
    });
  }

  async list(status: ApprovalStatus | null, limit = 100): Promise<ApprovalView[]> {
    return (await this.deps.approvals.list(status, limit)).map((r) => r.snapshot());
  }

  private executorFor(action: string): ApprovalExecutor {
    const executor = this.executors.get(action);
    if (executor === undefined) throw new Error(`No approval executor for ${action}`);
    return executor;
  }

  private meta() {
    const request = this.deps.requestContext.current();
    return { requestId: request?.requestId ?? null, ip: request?.ip ?? null };
  }
}
