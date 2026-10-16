import { DomainError } from "../errors/DomainError.js";

export type ApplicationStatus =
  "pending_verification" | "pending_review" | "needs_info" | "approved" | "rejected";

export type BusinessType = "fleet" | "rental" | "dealer" | "mixed";
export type RiskLevel = "low" | "medium" | "high";
export type RiskSignal = Readonly<{ code: string; detail: string }>;

export type ApplicationDetails = Readonly<{
  businessName: string;
  businessType: BusinessType;
  country: string;
  desiredSlug: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  tin: string | null;
  registrationNumber: string | null;
  expectedBranches: number;
  expectedVehicles: number;
  heardAbout: string | null;
  referralCode: string | null;
}>;

/** Fields the applicant may correct when answering an information request. */
export type ApplicationCorrections = Partial<
  Pick<
    ApplicationDetails,
    "businessName" | "tin" | "registrationNumber" | "expectedBranches" | "expectedVehicles"
  >
>;

export type ApprovalOptions = Readonly<{ plan: string; trialDays: number }>;

export type TenantApplicationProps = Readonly<{
  id: string;
  status: ApplicationStatus;
  source: "self" | "assisted";
  details: ApplicationDetails;
  createdByStaffId: string | null;
  accessTokenHash: string;
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
  submittedAt: Date | null;
  riskLevel: RiskLevel;
  riskSignals: readonly RiskSignal[];
  assignedTo: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  decisionReason: string | null;
  reapplyAfter: Date | null;
  approvalOptions: ApprovalOptions | null;
  createdIp: string | null;
  createdUserAgent: string | null;
  termsAcceptedAt: Date;
  createdAt: Date;
}>;

export class ApplicationStateError extends DomainError {
  readonly code = "APPLICATION_STATE";
  constructor(action: string, status: ApplicationStatus) {
    super(`Cannot ${action} an application that is ${status.replaceAll("_", " ")}`);
  }
}

export class ApplicationMessageRequiredError extends DomainError {
  readonly code = "MESSAGE_REQUIRED";
  constructor() {
    super("A message of at least 5 characters is required");
  }
}

/**
 * A request to become a tenant (docs/27 §3.2):
 *
 *   pending_verification → (email and phone verified) → pending_review
 *   pending_review → needs_info → (applicant replies) → pending_review
 *   pending_review | needs_info → approved | rejected
 *
 * Approval only records the decision and provisioning options; the database is created by the
 * provisioning saga (P1-3). A rejection can block re-applying for a while.
 */
export class TenantApplication {
  private constructor(private props: TenantApplicationProps) {}

  static submit(params: {
    id: string;
    details: ApplicationDetails;
    source: "self" | "assisted";
    createdByStaffId: string | null;
    accessTokenHash: string;
    risk: Readonly<{ level: RiskLevel; signals: readonly RiskSignal[] }>;
    ip: string | null;
    userAgent: string | null;
    now: Date;
  }): TenantApplication {
    return new TenantApplication({
      id: params.id,
      status: "pending_verification",
      source: params.source,
      details: params.details,
      createdByStaffId: params.createdByStaffId,
      accessTokenHash: params.accessTokenHash,
      emailVerifiedAt: null,
      phoneVerifiedAt: null,
      submittedAt: null,
      riskLevel: params.risk.level,
      riskSignals: params.risk.signals,
      assignedTo: null,
      reviewedBy: null,
      reviewedAt: null,
      decisionReason: null,
      reapplyAfter: null,
      approvalOptions: null,
      createdIp: params.ip,
      createdUserAgent: params.userAgent,
      termsAcceptedAt: params.now,
      createdAt: params.now,
    });
  }

  static restore(props: TenantApplicationProps): TenantApplication {
    return new TenantApplication(props);
  }

  get id(): string {
    return this.props.id;
  }
  get status(): ApplicationStatus {
    return this.props.status;
  }
  get details(): ApplicationDetails {
    return this.props.details;
  }
  get accessTokenHash(): string {
    return this.props.accessTokenHash;
  }

  isVerified(channel: "email" | "phone"): boolean {
    return (channel === "email" ? this.props.emailVerifiedAt : this.props.phoneVerifiedAt) !== null;
  }

  /** Returns true when this completed verification and the application entered review. */
  markVerified(channel: "email" | "phone", now: Date): boolean {
    if (this.props.status !== "pending_verification") {
      throw new ApplicationStateError("verify", this.props.status);
    }
    this.props =
      channel === "email"
        ? { ...this.props, emailVerifiedAt: this.props.emailVerifiedAt ?? now }
        : { ...this.props, phoneVerifiedAt: this.props.phoneVerifiedAt ?? now };
    if (this.props.emailVerifiedAt !== null && this.props.phoneVerifiedAt !== null) {
      this.props = { ...this.props, status: "pending_review", submittedAt: now };
      return true;
    }
    return false;
  }

  requestInfo(message: string): void {
    if (this.props.status !== "pending_review") {
      throw new ApplicationStateError("request information on", this.props.status);
    }
    if (message.trim().length < 5) throw new ApplicationMessageRequiredError();
    this.props = { ...this.props, status: "needs_info" };
  }

  reply(message: string, corrections: ApplicationCorrections): void {
    if (this.props.status !== "needs_info")
      throw new ApplicationStateError("reply to", this.props.status);
    if (message.trim().length < 5) throw new ApplicationMessageRequiredError();
    const defined = Object.fromEntries(
      Object.entries(corrections).filter(([, value]) => value !== undefined),
    ) as ApplicationCorrections;
    this.props = {
      ...this.props,
      status: "pending_review",
      details: { ...this.props.details, ...defined },
    };
  }

  assign(staffId: string | null): void {
    if (this.props.status === "approved" || this.props.status === "rejected") {
      throw new ApplicationStateError("assign", this.props.status);
    }
    this.props = { ...this.props, assignedTo: staffId };
  }

  approve(staffId: string, options: ApprovalOptions, note: string | null, now: Date): void {
    if (this.props.status !== "pending_review")
      throw new ApplicationStateError("approve", this.props.status);
    this.props = {
      ...this.props,
      status: "approved",
      reviewedBy: staffId,
      reviewedAt: now,
      decisionReason: note,
      approvalOptions: options,
    };
  }

  reject(staffId: string, reason: string, reapplyAfter: Date | null, now: Date): void {
    if (this.props.status !== "pending_review" && this.props.status !== "needs_info") {
      throw new ApplicationStateError("reject", this.props.status);
    }
    if (reason.trim().length < 5) throw new ApplicationMessageRequiredError();
    this.props = {
      ...this.props,
      status: "rejected",
      reviewedBy: staffId,
      reviewedAt: now,
      decisionReason: reason.trim(),
      reapplyAfter,
    };
  }

  snapshot(): TenantApplicationProps {
    return this.props;
  }
}
