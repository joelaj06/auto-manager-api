import { randomBytes } from "node:crypto";
import {
  challengeAnswered,
  checkDomain,
  CustomDomainRuleError,
  DOMAIN_CHALLENGE_LABEL,
  DOMAIN_CHALLENGE_PREFIX,
  DOMAIN_FAILED_CHECKS_LIMIT,
  MAX_TENANT_DOMAINS,
} from "../../../domain/console/CustomDomains.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { CustomDomainNotFoundError } from "../../errors/IntegrationErrors.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import { TenantNotFoundForStaffError } from "../../errors/TenantErrors.js";
import type { IClock } from "../../ports/IClock.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { ITenantDirectory } from "../../ports/ITenantDirectory.js";
import type {
  IDnsResolver,
  ITenantDomainLookup,
  ITenantDomains,
  TenantDomainRecord,
} from "../../ports/ITenantDomains.js";
import type { EnterpriseGate } from "../integrations/EnterpriseGate.js";
import type { IAlerts } from "./PlatformAlerts.js";

const sameName = (a: string, b: string) =>
  a.toLowerCase().replace(/\.$/, "") === b.toLowerCase().replace(/\.$/, "");

/**
 * A business's own host name (decisions 528–530), added by staff. The DNS proves it is theirs: a
 * TXT record with its token and, when a target is set, the name pointing at us. Only then does
 * the host name reach the tenant or get a certificate. Records that vanish suspend it.
 */
export class CustomDomains {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IPlatformUnitOfWork;
      domains: ITenantDomains;
      lookup: ITenantDomainLookup;
      dns: IDnsResolver;
      gate: EnterpriseGate;
      tenants: ITenantDirectory;
      audit: IPlatformAuditTrail;
      alerts: IAlerts;
      clock: IClock;
      logger: ILogger;
      /** The host name customers point theirs at; null: only the TXT record is checked. */
      target: string | null;
      /** Our own host names, never a tenant's. */
      reserved: readonly string[];
    }>,
  ) {}

  async list(tenantId: string) {
    await this.requireTenant(tenantId);
    return (await this.deps.domains.ofTenant(tenantId)).map((d) => this.view(d));
  }

  async add(actor: PlatformPrincipal, tenantId: string, value: string) {
    const { deps } = this;
    await this.requireTenant(tenantId);
    await deps.gate.require(tenantId);
    const domain = checkDomain(value, deps.reserved);
    const id = await deps.unitOfWork.run(async () => {
      if ((await deps.domains.findByDomain(domain)) !== null)
        throw new CustomDomainRuleError(`${domain} is already taken`);
      if ((await deps.domains.ofTenant(tenantId)).length >= MAX_TENANT_DOMAINS)
        throw new CustomDomainRuleError(`A tenant holds at most ${MAX_TENANT_DOMAINS} domains`);
      const created = await deps.domains.create({
        tenantId,
        domain,
        verificationToken: randomBytes(18).toString("base64url"),
        createdBy: actor.userId,
      });
      await this.audit(actor.userId, "tenant_domain.added", created, tenantId, { domain });
      return created;
    });
    return this.view((await deps.domains.find(id))!);
  }

  /** Checks a domain's DNS now; a domain that passes goes live within half a minute. */
  async verify(actor: PlatformPrincipal, tenantId: string, id: string) {
    const { deps } = this;
    const domain = await this.require(tenantId, id);
    await deps.gate.require(tenantId);
    const problem = await this.problemWith(domain);
    const now = deps.clock.now();
    await deps.unitOfWork.run(async () => {
      await deps.domains.update(id, {
        status: problem === null ? "active" : domain.status,
        ...(problem === null ? { verifiedAt: now } : {}),
        lastCheckedAt: now,
        lastError: problem,
        failedChecks: 0,
      });
      if (problem === null)
        await this.audit(actor.userId, "tenant_domain.verified", id, tenantId, {
          domain: domain.domain,
        });
    });
    deps.lookup.forget();
    return this.view((await deps.domains.find(id))!);
  }

  async remove(actor: PlatformPrincipal, tenantId: string, id: string): Promise<void> {
    const { deps } = this;
    const domain = await this.require(tenantId, id);
    await deps.unitOfWork.run(async () => {
      await deps.domains.remove(id);
      await this.audit(actor.userId, "tenant_domain.removed", id, tenantId, {
        domain: domain.domain,
      });
    });
    deps.lookup.forget();
  }

  /** For the proxy's on-demand certificates: only live domains get one. */
  async allowsCertificate(domain: string): Promise<boolean> {
    return (await this.deps.lookup.slugOf(domain.trim().toLowerCase())) !== null;
  }

  /** Daily: records that vanished suspend a domain after three days; back again restores it. */
  async sweep(): Promise<Readonly<{ checked: number; suspended: number; restored: number }>> {
    const { deps } = this;
    const domains = await deps.domains.verified();
    let suspended = 0;
    let restored = 0;
    for (const domain of domains) {
      const problem = await this.problemWith(domain);
      const now = deps.clock.now();
      const failures = problem === null ? 0 : domain.failedChecks + 1;
      const status =
        problem === null
          ? "active"
          : failures >= DOMAIN_FAILED_CHECKS_LIMIT
            ? "suspended"
            : domain.status;
      if (status === "suspended" && domain.status === "active") {
        suspended += 1;
        await deps.alerts.raise({
          key: `tenant_domain.suspended:${domain.id}`,
          severity: "warning",
          source: "domains",
          title: `${domain.domain} was suspended: its DNS records are gone`,
          detail: { tenantId: domain.tenantId, domain: domain.domain, problem },
          runbook: "Ask the customer to restore the records, then check the domain in the console",
        });
      }
      if (status === "active" && domain.status === "suspended") restored += 1;
      await deps.domains.update(domain.id, {
        status,
        lastCheckedAt: now,
        lastError: problem,
        failedChecks: failures,
      });
    }
    if (suspended > 0 || restored > 0) deps.lookup.forget();
    return { checked: domains.length, suspended, restored };
  }

  private async problemWith(domain: TenantDomainRecord): Promise<string | null> {
    const { dns, target } = this.deps;
    try {
      const txt = await dns.txt(`${DOMAIN_CHALLENGE_LABEL}.${domain.domain}`);
      if (!challengeAnswered(txt, domain.verificationToken))
        return `The TXT record ${DOMAIN_CHALLENGE_LABEL}.${domain.domain} is missing or different`;
      if (target === null) return null;
      const cnames = await dns.cnames(domain.domain);
      if (cnames.some((c) => sameName(c, target))) return null;
      // A root domain cannot have a CNAME: its provider flattens it to our addresses.
      const [ours, theirs] = await Promise.all([
        dns.addresses(target),
        dns.addresses(domain.domain),
      ]);
      if (ours.length > 0 && theirs.length > 0 && theirs.every((a) => ours.includes(a)))
        return null;
      return `${domain.domain} does not point at ${target}`;
    } catch (error) {
      this.deps.logger.warn("Could not check a custom domain", { domain: domain.domain, error });
      return "The DNS could not be read";
    }
  }

  private view(domain: TenantDomainRecord) {
    const { verificationToken, ...rest } = domain;
    return {
      ...rest,
      dns: {
        txt: {
          name: `${DOMAIN_CHALLENGE_LABEL}.${domain.domain}`,
          value: `${DOMAIN_CHALLENGE_PREFIX}${verificationToken}`,
        },
        cname: this.deps.target,
      },
    };
  }

  private async requireTenant(tenantId: string): Promise<void> {
    if ((await this.deps.tenants.findById(tenantId)) === null)
      throw new TenantNotFoundForStaffError();
  }

  private async require(tenantId: string, id: string): Promise<TenantDomainRecord> {
    const domain = await this.deps.domains.find(id);
    if (domain === null || domain.tenantId !== tenantId) throw new CustomDomainNotFoundError();
    return domain;
  }

  private audit(
    actorId: string,
    action: string,
    id: string,
    tenantId: string,
    after: Record<string, unknown>,
  ) {
    return this.deps.audit.record({
      actorType: "platform_staff",
      actorId,
      action,
      entityType: "tenant_domain",
      entityId: id,
      targetTenantId: tenantId,
      after,
    });
  }
}

/** The daily check of every verified domain's DNS. */
export class SweepCustomDomains implements IJobHandler<"domains.sweep"> {
  readonly job = "domains.sweep" as const;

  constructor(private readonly domains: Pick<CustomDomains, "sweep">) {}

  async handle(): Promise<void> {
    await this.domains.sweep();
  }
}
