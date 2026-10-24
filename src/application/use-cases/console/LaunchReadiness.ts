import type { IPlatformRoles } from "../../ports/IPlatformRoles.js";
import type { IClock } from "../../ports/IClock.js";
import type { BillingAutomation } from "../billing/BillingAutomation.js";
import { DRY_RUN_REVIEW_DAYS } from "../billing/BillingAutomation.js";
import type { SubscriptionAdministration } from "../billing/SubscriptionAdministration.js";
import type { RestoreDrills } from "./ComplianceOperations.js";
import type { DataOperationsConsole } from "./DataOperationsConsole.js";
import type { LegalDocuments } from "./LegalDocuments.js";
import type { PlatformAlerts } from "./PlatformAlerts.js";

export type CheckStatus = "pass" | "warn" | "fail";

export type ReadinessCheck = Readonly<{
  key: string;
  area: "billing" | "legal" | "operations" | "security" | "data";
  title: string;
  status: CheckStatus;
  detail: string;
  /** What to do when it is not a pass. */
  fix: string | null;
}>;

export type LaunchReadinessReport = Readonly<{
  /** No failing check (warnings are judgement calls, recorded in the go-live checklist). */
  ready: boolean;
  counts: Readonly<Record<CheckStatus, number>>;
  checks: readonly ReadinessCheck[];
  checkedAt: Date;
}>;

export type ReadinessSettings = Readonly<{
  production: boolean;
  gateway: "fake" | "paystack";
  onCallEmails: number;
  onCallWebhook: boolean;
}>;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The go-live gate (docs/30 P4-9, docs/36): every launch condition the platform can see for
 * itself — prices and the seller on invoices, the real gateway, the billing automation in dry
 * run and its review, terms and privacy published, on-call reachable, backups recent and
 * restorable, a restore drill on the calendar, every tenant on the current schema, no critical
 * alert, two Super Admins (four-eyes) and a support team. Read-only; failures say what to fix.
 */
export class LaunchReadiness {
  constructor(
    private readonly deps: Readonly<{
      subscriptions: SubscriptionAdministration;
      automation: BillingAutomation;
      legal: LegalDocuments;
      alerts: PlatformAlerts;
      drills: RestoreDrills;
      dataOperations: DataOperationsConsole;
      roles: IPlatformRoles;
      clock: IClock;
      settings: ReadinessSettings;
    }>,
  ) {}

  async report(): Promise<LaunchReadinessReport> {
    const checks = [
      ...(await this.billing()),
      ...(await this.legalChecks()),
      ...(await this.operations()),
      ...(await this.security()),
    ];
    const counts = { pass: 0, warn: 0, fail: 0 };
    for (const c of checks) counts[c.status] += 1;
    return { ready: counts.fail === 0, counts, checks, checkedAt: this.deps.clock.now() };
  }

  private async billing(): Promise<ReadinessCheck[]> {
    const { deps } = this;
    const standard = (await deps.subscriptions.plans()).find((p) => p.code === "standard");
    const settings = await deps.subscriptions.billingSettings();
    const { policy } = await deps.automation.policy();
    const review = await deps.automation.dryRunReview(DRY_RUN_REVIEW_DAYS * 2);
    return [
      check(
        "billing.price",
        "billing",
        "Standard price per branch set",
        standard !== undefined && standard.branchPriceMinor !== null ? "pass" : "fail",
        standard !== undefined && standard.branchPriceMinor !== null
          ? `${standard.currency} ${(standard.branchPriceMinor / 100).toFixed(2)} per branch per month`
          : "No price: invoices cannot be issued",
        "PUT /api/platform/v1/billing/plans/standard/price",
      ),
      check(
        "billing.seller",
        "billing",
        "Autoforce as the seller on invoices",
        settings.sellerTin !== null && settings.paymentInstructions !== null ? "pass" : "warn",
        `${settings.sellerName}; TIN ${settings.sellerTin ?? "missing"}; payment instructions ${settings.paymentInstructions === null ? "missing" : "set"}; VAT ${settings.vatRegistered ? "registered" : "not registered"}`,
        "PUT /api/platform/v1/billing/settings (confirm VAT registration with the accountant)",
      ),
      check(
        "billing.gateway",
        "billing",
        "Real payment gateway",
        deps.settings.gateway === "paystack" ? "pass" : deps.settings.production ? "fail" : "warn",
        `BILLING_GATEWAY=${deps.settings.gateway}`,
        "BILLING_GATEWAY=paystack with PAYSTACK_SECRET_KEY (live key in production only)",
      ),
      check(
        "billing.dry_run",
        "billing",
        "Billing automation in dry run, reviewed before it acts",
        // Dry run at launch is expected; a short dry-run history is the judgement call.
        review.dryRunDays >= DRY_RUN_REVIEW_DAYS ? "pass" : "warn",
        policy.dryRun
          ? `Dry run on: ${review.dryRunDays} day(s) of runs, ${review.wouldDeactivate.length} would-be deactivations (${review.paidAfterFlag} paid since), ${review.halted} halted, ${review.failed} failed`
          : `Dry run off; ${review.dryRunDays} day(s) of dry runs before it`,
        `Keep dry run on for the first ${DRY_RUN_REVIEW_DAYS} days; read GET billing/automation/dry-run-review before turning it off`,
      ),
    ];
  }

  private async legalChecks(): Promise<ReadinessCheck[]> {
    const out: ReadinessCheck[] = [];
    for (const kind of ["terms", "privacy"] as const) {
      const current = await this.deps.legal.current(kind).catch(() => null);
      out.push(
        check(
          `legal.${kind}`,
          "legal",
          kind === "terms" ? "Terms of service in force" : "Privacy policy in force",
          current === null ? "fail" : "pass",
          current === null
            ? "Nothing published"
            : `Version ${current.version} since ${current.effectiveAt?.toISOString().slice(0, 10)}`,
          "Draft and publish it (console legal documents), reviewed by counsel",
        ),
      );
    }
    return out;
  }

  private async operations(): Promise<ReadinessCheck[]> {
    const { deps } = this;
    const now = deps.clock.now();
    const backups = await deps.dataOperations.backupOverview();
    const migrations = await deps.dataOperations.migrations();
    const drills = await deps.drills.list(20);
    const scheduled = drills.find(
      (d) => d.kind === "quarterly_game_day" && d.status === "scheduled",
    );
    const lastDone = drills.find((d) => d.status === "done");
    const alerts = await deps.alerts.openCounts();
    const recentBackup =
      backups.lastPlatform.succeededAt !== null &&
      now.getTime() - backups.lastPlatform.succeededAt.getTime() < 36 * HOUR_MS;
    const verified =
      backups.lastVerification !== null &&
      backups.lastVerification.passed &&
      now.getTime() - backups.lastVerification.at.getTime() < 8 * DAY_MS;
    return [
      check(
        "ops.on_call",
        "operations",
        "On-call reachable",
        deps.settings.onCallEmails > 0 || deps.settings.onCallWebhook ? "pass" : "fail",
        `${deps.settings.onCallEmails} on-call email(s); webhook ${deps.settings.onCallWebhook ? "set" : "not set"}`,
        "ONCALL_EMAILS and/or ONCALL_WEBHOOK_URL (doc 33 §8)",
      ),
      check(
        "ops.backups",
        "data",
        "Backups in the last 36 hours",
        recentBackup && backups.tenantsWithoutRecentBackup.count === 0 ? "pass" : "fail",
        `Platform ${backups.lastPlatform.succeededAt?.toISOString() ?? "never"}; ${backups.tenantsWithoutRecentBackup.count} tenant(s) without a recent backup`,
        "yarn backup run, then schedule it (doc 31 §3)",
      ),
      check(
        "ops.restore_test",
        "data",
        "A restore test passed this week",
        verified ? "pass" : "fail",
        backups.lastVerification === null
          ? "Never verified"
          : `${backups.lastVerification.passed ? "Passed" : "Failed"} ${backups.lastVerification.at.toISOString()}`,
        "yarn backup verify --sample 3 (doc 31 §4)",
      ),
      check(
        "ops.drill",
        "data",
        "Quarterly restore drill on the calendar, one done",
        scheduled === undefined ? "fail" : lastDone === undefined ? "warn" : "pass",
        `${scheduled === undefined ? "None scheduled" : `Due ${scheduled.dueOn}`}; last done ${lastDone?.performedAt?.toISOString().slice(0, 10) ?? "never"}`,
        "Run the drill (doc 33 §10) and record it",
      ),
      check(
        "ops.migrations",
        "data",
        "Every tenant on the current schema",
        migrations.platform.upToDate &&
          migrations.tenants.behind === 0 &&
          migrations.tenants.failed === 0
          ? "pass"
          : "fail",
        `Platform ${migrations.platform.upToDate ? "current" : "behind"}; tenants ${migrations.tenants.upToDate}/${migrations.tenants.total} current, ${migrations.tenants.failed} failed`,
        "yarn db:migrate; fix failures (console migrations)",
      ),
      check(
        "ops.alerts",
        "operations",
        "No open critical alert",
        alerts.critical === 0 ? "pass" : "fail",
        `${alerts.critical} critical, ${alerts.warning} warning, ${alerts.info} info open`,
        "Work through the alerts centre (doc 33 §8)",
      ),
    ];
  }

  private async security(): Promise<ReadinessCheck[]> {
    const { deps } = this;
    const superAdmins = await deps.roles.activeUsersWithSystemRole("super_admin");
    const support = await deps.roles.activeUsersWithSystemRole("support");
    return [
      check(
        "security.four_eyes",
        "security",
        "Two Super Admins (four-eyes approvals possible)",
        superAdmins.length >= 2 ? "pass" : "fail",
        `${superAdmins.length} active Super Admin(s)`,
        "Invite a second Super Admin (MFA enforced)",
      ),
      check(
        "security.support_team",
        "operations",
        "A support team in the console",
        support.length > 0 ? "pass" : "warn",
        `${support.length} active Support user(s)`,
        "Invite the support staff (doc 35)",
      ),
      check(
        "security.environment",
        "security",
        "Production configuration",
        deps.settings.production ? "pass" : "warn",
        deps.settings.production
          ? "NODE_ENV=production"
          : "Not production: checks that only make sense hosted are relaxed",
        "Hosting (P0-3): production environment, secrets in the host's store",
      ),
    ];
  }
}

function check(
  key: string,
  area: ReadinessCheck["area"],
  title: string,
  status: CheckStatus,
  detail: string,
  fix: string,
): ReadinessCheck {
  return { key, area, title, status, detail, fix: status === "pass" ? null : fix };
}
