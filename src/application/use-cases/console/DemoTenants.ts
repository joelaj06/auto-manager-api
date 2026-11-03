import { randomBytes, randomUUID } from "node:crypto";
import {
  DEMO_MAX_LIVE,
  DEMO_PURGE_AFTER_DAYS,
  DemoRuleError,
  demoDays,
  demoSlug,
  demoState,
  extendDemo,
  type DemoPurpose,
} from "../../../domain/console/DemoTenants.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { JobPayloads } from "../../jobs/jobCatalog.js";
import type { IClock } from "../../ports/IClock.js";
import type { IClusterRouting } from "../../ports/IClusterRegistry.js";
import type {
  BusinessType,
  DemoTenant,
  IDemoSampleData,
  IDemoTenants,
} from "../../ports/IDemoTenants.js";
import type { IJobQueue } from "../../ports/IJobQueue.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { ITenantProvisioning } from "../../ports/ITenantProvisioning.js";

const DAY_MS = 86_400_000;

export type NewDemoInput = Readonly<{
  businessName: string;
  businessType: BusinessType;
  slug?: string | null;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  purpose: DemoPurpose;
  prospect?: string | null;
  days?: number;
  sampleData: boolean;
}>;

/** The status changes of a demo (the lifecycle service). */
export type DemoTransitions = Readonly<{
  endDemo(tenantId: string): Promise<void>;
  reopenDemo(tenantId: string, actor: PlatformPrincipal): Promise<void>;
}>;

/**
 * Demo and sandbox tenants (docs/27 §5.2, decision 501): created by staff in one step for a
 * sales demo or training, provisioned like any tenant (the contact gets the owner's sign-in) and
 * filled with sample data; never billed and left out of analytics; deactivated at their end and
 * purged — their database dropped — a week later unless extended. The only tenants whose data is
 * ever removed (docs/26 §8).
 */
export class DemoTenants {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IPlatformUnitOfWork;
      demos: IDemoTenants;
      provisioning: ITenantProvisioning;
      lifecycle: DemoTransitions;
      queue: IJobQueue;
      audit: IPlatformAuditTrail;
      clock: IClock;
      timezone: string;
    }>,
  ) {}

  list(filter: Readonly<{ live?: boolean; limit: number }>): Promise<DemoTenant[]> {
    return this.deps.demos.list(filter);
  }

  async demo(tenantId: string): Promise<DemoTenant> {
    const demo = await this.deps.demos.find(tenantId);
    if (demo === null) throw new DemoRuleError("No such demo tenant");
    return demo;
  }

  async create(actor: PlatformPrincipal, input: NewDemoInput): Promise<DemoTenant> {
    const { deps } = this;
    if ((await deps.demos.liveCount()) >= DEMO_MAX_LIVE)
      throw new DemoRuleError(
        `There are already ${DEMO_MAX_LIVE} demos; let one end or expire one first`,
      );
    const days = demoDays(input.days);
    const slug = input.slug?.trim().toLowerCase() || (await this.freeSlug());
    if (await deps.demos.slugTaken(slug)) throw new DemoRuleError(`The address ${slug} is taken`);
    const now = deps.clock.now();
    const tenantId = randomUUID();
    const demo = {
      tenantId,
      slug,
      name: input.businessName.trim(),
      businessType: input.businessType,
      contactName: input.contactName.trim(),
      contactEmail: input.contactEmail.trim().toLowerCase(),
      contactPhone: input.contactPhone,
      purpose: input.purpose,
      prospect: input.prospect?.trim() || null,
      trialDays: days,
      expiresAt: new Date(now.getTime() + days * DAY_MS),
      sampleData: input.sampleData,
      createdBy: actor.userId,
    };
    await deps.unitOfWork.run(async () => {
      const applicationId = await deps.demos.createApplication(demo);
      await deps.provisioning.register({
        tenantId,
        slug,
        name: demo.name,
        timezone: deps.timezone,
        applicationId,
      });
      await deps.demos.markDemo(demo);
      await deps.audit.record({
        actorType: "platform_staff",
        actorId: actor.userId,
        action: "tenant.demo_created",
        entityType: "tenant",
        entityId: tenantId,
        targetTenantId: tenantId,
        after: {
          slug,
          purpose: demo.purpose,
          days,
          sampleData: demo.sampleData,
          contactEmail: demo.contactEmail,
        },
      });
    });
    await deps.queue
      .enqueue("tenant.provision", { tenantId }, { singletonKey: tenantId })
      .catch(() => undefined); // the provisioning sweep re-queues it within minutes
    return this.demo(tenantId);
  }

  /** More days; an expired demo (not purged yet) is opened again. */
  async extend(actor: PlatformPrincipal, tenantId: string, days: number): Promise<DemoTenant> {
    const { deps } = this;
    const demo = await this.demo(tenantId);
    const now = deps.clock.now();
    const until = extendDemo(demo, days, now);
    if (demo.expiredAt !== null) await deps.lifecycle.reopenDemo(tenantId, actor);
    await deps.demos.update(tenantId, {
      expiresAt: until,
      extensions: demo.extensions + 1,
      expiredAt: null,
    });
    await deps.audit.record({
      actorType: "platform_staff",
      actorId: actor.userId,
      action: "tenant.demo_extended",
      entityType: "tenant",
      entityId: tenantId,
      targetTenantId: tenantId,
      before: { expiresAt: demo.expiresAt.toISOString() },
      after: { expiresAt: until.toISOString(), reopened: demo.expiredAt !== null },
    });
    return this.demo(tenantId);
  }

  /** Ends a demo now (deactivated; purged a week later). */
  async end(actor: PlatformPrincipal, tenantId: string): Promise<DemoTenant> {
    const { deps } = this;
    const demo = await this.demo(tenantId);
    if (demoState(demo, deps.clock.now()) !== "live")
      throw new DemoRuleError("This demo has already ended");
    if (demo.provisioning !== "completed")
      throw new DemoRuleError("The demo is still being set up");
    await deps.lifecycle.endDemo(tenantId);
    const now = deps.clock.now();
    await deps.demos.update(tenantId, { expiresAt: now, expiredAt: now });
    await deps.audit.record({
      actorType: "platform_staff",
      actorId: actor.userId,
      action: "tenant.demo_ended",
      entityType: "tenant",
      entityId: tenantId,
      targetTenantId: tenantId,
      after: { purgeOn: new Date(now.getTime() + DEMO_PURGE_AFTER_DAYS * DAY_MS).toISOString() },
    });
    return this.demo(tenantId);
  }

  /** Called once a tenant is provisioned: queues the sample data of a demo. True for a demo. */
  async provisioned(tenantId: string): Promise<boolean> {
    const demo = await this.deps.demos.find(tenantId);
    if (demo === null) return false;
    if (demo.sampleData === "pending")
      await this.deps.queue.enqueue("tenant.demo_seed", { tenantId }, { singletonKey: tenantId });
    return true;
  }

  private async freeSlug(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = demoSlug(randomBytes(8).toString("hex"));
      if (!(await this.deps.demos.slugTaken(slug))) return slug;
    }
    throw new DemoRuleError("Could not find a free demo address; give one");
  }
}

/** Fills a demo with sample data, resuming after the sections already done. */
export class SeedDemoTenant implements IJobHandler<"tenant.demo_seed"> {
  readonly job = "tenant.demo_seed" as const;

  constructor(
    private readonly deps: Readonly<{
      demos: IDemoTenants;
      sampleData: IDemoSampleData;
      audit: IPlatformAuditTrail;
      logger: ILogger;
    }>,
  ) {}

  async handle({ tenantId }: JobPayloads["tenant.demo_seed"]): Promise<void> {
    const { deps } = this;
    const demo = await deps.demos.find(tenantId);
    if (demo === null || demo.sampleData === "seeded" || demo.sampleData === "none") return;
    if (demo.purgedAt !== null || demo.expiredAt !== null) return;
    if (demo.provisioning !== "completed") throw new Error("The demo is still being provisioned");
    await deps.demos.update(tenantId, { sampleData: "seeding", sampleError: null });
    try {
      const report = await deps.sampleData.seed(
        { tenantId, slug: demo.slug, businessType: demo.businessType },
        demo.sampleReport,
        (progress) => deps.demos.update(tenantId, { sampleReport: progress }),
      );
      await deps.demos.update(tenantId, { sampleData: "seeded", sampleReport: report });
      await deps.audit.record({
        actorType: "system",
        action: "tenant.demo_seeded",
        entityType: "tenant",
        entityId: tenantId,
        targetTenantId: tenantId,
        after: { ...report },
      });
      deps.logger.info("Demo tenant filled with sample data", { tenantId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.demos.update(tenantId, {
        sampleData: "failed",
        sampleError: message.slice(0, 2_000),
      });
      throw error;
    }
  }
}

/**
 * Hourly: demos past their end are deactivated (sessions ended), those ended a week ago are
 * purged — their database is dropped and the tenant keeps no data (decision 501) — and sample
 * data left unfinished is queued again.
 */
export class SweepDemoTenants implements IJobHandler<"demos.sweep"> {
  readonly job = "demos.sweep" as const;

  constructor(
    private readonly deps: Readonly<{
      demos: IDemoTenants;
      lifecycle: DemoTransitions;
      databases: Readonly<{ dropDatabase(tenantId: string, clusterId: string): Promise<boolean> }>;
      routing: IClusterRouting;
      queue: IJobQueue;
      audit: IPlatformAuditTrail;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  async handle(): Promise<void> {
    const { deps } = this;
    const now = deps.clock.now();
    const due = await deps.demos.due(now, new Date(now.getTime() - DEMO_PURGE_AFTER_DAYS * DAY_MS));
    for (const tenantId of due.expire) {
      try {
        await deps.lifecycle.endDemo(tenantId);
        await deps.demos.update(tenantId, { expiredAt: now });
        await deps.audit.record({
          actorType: "system",
          action: "tenant.demo_expired",
          entityType: "tenant",
          entityId: tenantId,
          targetTenantId: tenantId,
        });
      } catch (error) {
        deps.logger.error("Could not expire a demo tenant", { tenantId, error });
      }
    }
    for (const tenantId of due.seed)
      await deps.queue.enqueue("tenant.demo_seed", { tenantId }, { singletonKey: tenantId });
    for (const tenantId of due.purge) {
      const demo = await deps.demos.find(tenantId);
      if (demo === null || demoState(demo, now) !== "purge_due") continue;
      if (demo.tenantStatus !== "deactivated") continue;
      const dropped = await deps.databases.dropDatabase(tenantId, demo.clusterId);
      await deps.demos.forgetDatabase(tenantId);
      deps.routing.forget(tenantId);
      await deps.demos.update(tenantId, { purgedAt: now });
      await deps.audit.record({
        actorType: "system",
        action: "tenant.demo_purged",
        entityType: "tenant",
        entityId: tenantId,
        targetTenantId: tenantId,
        after: { databaseDropped: dropped, clusterId: demo.clusterId },
      });
      deps.logger.info("Demo tenant purged", { tenantId });
    }
  }
}
