import type { RiskLevel, RiskSignal } from "../../domain/entities/TenantApplication.js";
import type { IApplicationLookups } from "../ports/IApplicationLookups.js";

/** Throw-away email providers (a small, maintained subset; extend as abuse shows up). */
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "yopmail.com",
  "trashmail.com",
  "sharklasers.com",
  "getnada.com",
  "dispostable.com",
  "maildrop.cc",
  "throwawaymail.com",
  "fakeinbox.com",
  "moakt.com",
  "mintemail.com",
]);

const IP_WINDOW_MS = 24 * 3_600_000;
const IP_LIMIT = 3;
/** Signals that on their own make an application high risk. */
const HIGH = new Set(["previously_rejected", "disposable_email"]);

/**
 * Basic risk signals shown to reviewers (docs/27 §3.2). Signals never decide on their own at
 * launch (manual approval); they focus the reviewer and, later, gate auto-approval.
 */
export class ApplicationRiskAssessor {
  constructor(private readonly lookups: IApplicationLookups) {}

  async assess(params: {
    applicationId?: string;
    email: string;
    phone: string;
    businessName: string;
    ip: string | null;
    now: Date;
  }): Promise<Readonly<{ level: RiskLevel; signals: RiskSignal[] }>> {
    const signals: RiskSignal[] = [];
    const domain = params.email.split("@")[1]?.toLowerCase() ?? "";
    if (DISPOSABLE_DOMAINS.has(domain)) {
      signals.push({ code: "disposable_email", detail: `Disposable email provider (${domain})` });
    }

    const similar = await this.lookups.similar({
      ...(params.applicationId === undefined ? {} : { excludeId: params.applicationId }),
      email: params.email,
      phone: params.phone,
      businessName: params.businessName,
    });
    const rejected = similar.filter(
      (s) => s.status === "rejected" && s.matchedOn.some((m) => m !== "business_name"),
    );
    if (rejected.length > 0) {
      signals.push({
        code: "previously_rejected",
        detail: `${rejected.length} earlier rejected application(s) with the same contact`,
      });
    }
    const approved = similar.filter((s) => s.status === "approved");
    if (approved.length > 0) {
      signals.push({
        code: "existing_customer",
        detail: `${approved.length} approved application(s) with the same contact or name`,
      });
    }
    if (similar.some((s) => s.matchedOn.includes("business_name") && s.status !== "rejected")) {
      signals.push({
        code: "duplicate_business_name",
        detail: "Another application uses the same business name",
      });
    }
    if ((await this.lookups.tenantsNamed(params.businessName)) > 0) {
      signals.push({
        code: "existing_tenant_name",
        detail: "A tenant with this business name already exists",
      });
    }
    if (params.ip !== null) {
      const count = await this.lookups.applicationsFromIpSince(
        params.ip,
        new Date(params.now.getTime() - IP_WINDOW_MS),
      );
      if (count >= IP_LIMIT) {
        signals.push({
          code: "ip_velocity",
          detail: `${count} applications from the same IP address in 24 hours`,
        });
      }
    }

    const level: RiskLevel = signals.some((s) => HIGH.has(s.code))
      ? "high"
      : signals.length > 0
        ? "medium"
        : "low";
    return { level, signals };
  }
}
