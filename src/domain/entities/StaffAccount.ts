import { DomainError } from "../errors/DomainError.js";

export type StaffStatus = "invited" | "active" | "disabled";

export type StaffAccountProps = Readonly<{
  id: string;
  email: string;
  name: string;
  status: StaffStatus;
  passwordHash: string | null;
  /** Sealed (encrypted) TOTP secret; present once enrolment started. */
  totpSecretSealed: string | null;
  totpEnrolledAt: Date | null;
  /** Last accepted TOTP time step — a code is never accepted twice. */
  totpLastStep: number | null;
  permissionVersion: number;
  failedAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  /** Set for a reseller's console user (docs/29 §2); null for platform staff. */
  partnerId: string | null;
}>;

export type LockoutPolicy = Readonly<{ maxFailedAttempts: number; lockMs: number }>;

export class StaffAccountDisabledError extends DomainError {
  readonly code = "STAFF_DISABLED";
  constructor() {
    super("This staff account is disabled");
  }
}

export class StaffMfaNotEnrolledError extends DomainError {
  readonly code = "MFA_NOT_ENROLLED";
  constructor() {
    super("Two-factor authentication is not set up for this account");
  }
}

/**
 * A platform staff member (docs/27 §2). Invite-only: the account starts `invited`, becomes
 * `active` once a password is set and an authenticator app is enrolled, and can be disabled and
 * enabled again (never deleted). Repeated failed sign-ins lock it for a while.
 *
 * Any change that must invalidate outstanding access tokens (disable, role change, MFA reset)
 * bumps `permissionVersion`.
 */
export class StaffAccount {
  private constructor(private props: StaffAccountProps) {}

  static invite(params: {
    id: string;
    email: string;
    name: string;
    partnerId?: string | null;
  }): StaffAccount {
    return new StaffAccount({
      id: params.id,
      email: params.email.trim().toLowerCase(),
      name: params.name.trim(),
      status: "invited",
      passwordHash: null,
      totpSecretSealed: null,
      totpEnrolledAt: null,
      totpLastStep: null,
      permissionVersion: 1,
      failedAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
      partnerId: params.partnerId ?? null,
    });
  }

  static restore(props: StaffAccountProps): StaffAccount {
    return new StaffAccount(props);
  }

  get id(): string {
    return this.props.id;
  }
  get email(): string {
    return this.props.email;
  }
  get name(): string {
    return this.props.name;
  }
  get status(): StaffStatus {
    return this.props.status;
  }
  get passwordHash(): string | null {
    return this.props.passwordHash;
  }
  get totpSecretSealed(): string | null {
    return this.props.totpSecretSealed;
  }
  get totpLastStep(): number | null {
    return this.props.totpLastStep;
  }
  get permissionVersion(): number {
    return this.props.permissionVersion;
  }
  get partnerId(): string | null {
    return this.props.partnerId;
  }
  get isPartnerUser(): boolean {
    return this.props.partnerId !== null;
  }
  get mfaEnrolled(): boolean {
    return this.props.totpEnrolledAt !== null;
  }

  isLocked(now: Date): boolean {
    return this.props.lockedUntil !== null && now < this.props.lockedUntil;
  }

  /** Accepting the invitation sets the first password. */
  setPassword(passwordHash: string): void {
    if (this.props.status === "disabled") throw new StaffAccountDisabledError();
    this.props = { ...this.props, passwordHash };
  }

  /** Stores a new (not yet confirmed) TOTP secret; replaces any unconfirmed one. */
  startTotpEnrolment(secretSealed: string): void {
    if (this.props.status === "disabled") throw new StaffAccountDisabledError();
    this.props = { ...this.props, totpSecretSealed: secretSealed, totpEnrolledAt: null };
  }

  /** The first valid code confirms enrolment and activates the account. */
  confirmTotpEnrolment(step: number, now: Date): void {
    if (this.props.status === "disabled") throw new StaffAccountDisabledError();
    if (this.props.totpSecretSealed === null || this.props.passwordHash === null) {
      throw new StaffMfaNotEnrolledError();
    }
    this.props = { ...this.props, totpEnrolledAt: now, totpLastStep: step, status: "active" };
  }

  /** Records a used TOTP step (successful second factor). */
  acceptTotpStep(step: number): void {
    this.props = { ...this.props, totpLastStep: step };
  }

  /** Returns true when this failure locked the account. */
  recordFailedAttempt(now: Date, policy: LockoutPolicy): boolean {
    const failedAttempts = this.props.failedAttempts + 1;
    const lock = failedAttempts >= policy.maxFailedAttempts;
    this.props = {
      ...this.props,
      failedAttempts: lock ? 0 : failedAttempts,
      lockedUntil: lock ? new Date(now.getTime() + policy.lockMs) : this.props.lockedUntil,
    };
    return lock;
  }

  recordSuccessfulLogin(now: Date): void {
    this.props = { ...this.props, failedAttempts: 0, lockedUntil: null, lastLoginAt: now };
  }

  disable(): void {
    if (this.props.status === "disabled") return;
    this.props = {
      ...this.props,
      status: "disabled",
      permissionVersion: this.props.permissionVersion + 1,
    };
  }

  enable(): void {
    if (this.props.status !== "disabled") return;
    this.props = {
      ...this.props,
      status: this.props.totpEnrolledAt === null ? "invited" : "active",
      failedAttempts: 0,
      lockedUntil: null,
    };
  }

  /** Lost phone: the next sign-in must enrol a new authenticator. */
  resetMfa(): void {
    this.props = {
      ...this.props,
      status: this.props.status === "disabled" ? "disabled" : "invited",
      totpSecretSealed: null,
      totpEnrolledAt: null,
      totpLastStep: null,
      permissionVersion: this.props.permissionVersion + 1,
    };
  }

  /** Roles changed: outstanding access tokens must be re-issued. */
  bumpPermissionVersion(): void {
    this.props = { ...this.props, permissionVersion: this.props.permissionVersion + 1 };
  }

  snapshot(): StaffAccountProps {
    return this.props;
  }
}
