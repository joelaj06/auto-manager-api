import { DomainError } from "../errors/DomainError.js";
import type { LockoutPolicy } from "./StaffAccount.js";

export type TenantUserStatus = "invited" | "active" | "disabled";

export type TenantUserProps = Readonly<{
  id: string;
  email: string | null;
  phone: string | null;
  name: string;
  status: TenantUserStatus;
  passwordHash: string | null;
  isOwner: boolean;
  permissionVersion: number;
  failedAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
}>;

export class OwnerProtectedError extends DomainError {
  readonly code = "OWNER_PROTECTED";
  constructor() {
    super("The owner cannot be disabled or have their roles changed here");
  }
}

export class UserEmailError extends DomainError {
  readonly code = "USER_EMAIL";
  constructor(message: string) {
    super(message);
  }
}

export class UserDisabledError extends DomainError {
  readonly code = "USER_DISABLED";
  constructor() {
    super("This user is disabled");
  }
}

/**
 * A person in a tenant (docs/28 §3.3). Invited users activate by setting a password. Repeated
 * failed sign-ins lock the account for a while. Disabling, changing roles and changing the
 * password bump `permissionVersion`, so outstanding access tokens stop working at once.
 */
export class TenantUser {
  private constructor(private props: TenantUserProps) {}

  static invite(params: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
  }): TenantUser {
    return new TenantUser({
      id: params.id,
      email: params.email?.trim().toLowerCase() ?? null,
      phone: params.phone,
      name: params.name.trim(),
      status: "invited",
      passwordHash: null,
      isOwner: false,
      permissionVersion: 1,
      failedAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
    });
  }

  static restore(props: TenantUserProps): TenantUser {
    return new TenantUser(props);
  }

  get id(): string {
    return this.props.id;
  }
  get email(): string | null {
    return this.props.email;
  }
  get phone(): string | null {
    return this.props.phone;
  }
  get name(): string {
    return this.props.name;
  }
  get status(): TenantUserStatus {
    return this.props.status;
  }
  get isOwner(): boolean {
    return this.props.isOwner;
  }
  get passwordHash(): string | null {
    return this.props.passwordHash;
  }
  get permissionVersion(): number {
    return this.props.permissionVersion;
  }

  isLocked(now: Date): boolean {
    return this.props.lockedUntil !== null && now < this.props.lockedUntil;
  }

  /** Accepting an invitation, or a password reset: sets the password and activates. */
  setPassword(passwordHash: string): void {
    if (this.props.status === "disabled") throw new UserDisabledError();
    this.props = {
      ...this.props,
      passwordHash,
      status: "active",
      // A new password ends every other access (sessions are revoked by the caller).
      permissionVersion:
        this.props.passwordHash === null
          ? this.props.permissionVersion
          : this.props.permissionVersion + 1,
      failedAttempts: 0,
      lockedUntil: null,
    };
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

  update(changes: Readonly<{ name?: string; phone?: string | null }>): void {
    this.props = {
      ...this.props,
      ...(changes.name === undefined ? {} : { name: changes.name.trim() }),
      ...(changes.phone === undefined ? {} : { phone: changes.phone }),
    };
  }

  disable(): void {
    if (this.props.isOwner) throw new OwnerProtectedError();
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
      status: this.props.passwordHash === null ? "invited" : "active",
      failedAttempts: 0,
      lockedUntil: null,
    };
  }

  /** Support: lifts a sign-in lockout at once. */
  unlock(): void {
    this.props = { ...this.props, failedAttempts: 0, lockedUntil: null };
  }

  /**
   * Owner recovery (docs/27 §3.7): a new sign-in email, checked by staff. Everything signed in
   * with the old address stops working.
   */
  changeEmail(email: string): void {
    const normalised = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalised))
      throw new UserEmailError("Enter a valid email address");
    if (normalised === this.props.email) throw new UserEmailError("This is already the email");
    this.props = {
      ...this.props,
      email: normalised,
      permissionVersion: this.props.permissionVersion + 1,
      failedAttempts: 0,
      lockedUntil: null,
    };
  }

  bumpPermissionVersion(): void {
    this.props = { ...this.props, permissionVersion: this.props.permissionVersion + 1 };
  }

  snapshot(): TenantUserProps {
    return this.props;
  }
}
