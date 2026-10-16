import { DomainError } from "../errors/DomainError.js";
import type { ReferralCode } from "../value-objects/ReferralCode.js";

export type PartnerStatus = "active" | "paused" | "terminated";

export type PartnerProfile = Readonly<{
  name: string;
  kind: "individual" | "company";
  contactName: string;
  email: string;
  /** E.164. */
  phone: string;
  region: string | null;
  address: string | null;
  tin: string | null;
}>;

export type PartnerProps = Readonly<{
  id: string;
  profile: PartnerProfile;
  status: PartnerStatus;
  statusReason: string | null;
  statusChangedAt: Date | null;
  trusted: boolean;
  referralCode: string;
  /** Capability permission keys granted to this partner (docs/29 §7). */
  capabilities: readonly string[];
  createdAt: Date;
  version: number;
}>;

export class PartnerStateError extends DomainError {
  readonly code = "PARTNER_STATE";
  constructor(message: string) {
    super(message);
  }
}

/** The partner may not bring in new business while paused or terminated. */
export class PartnerInactiveError extends DomainError {
  readonly code = "PARTNER_INACTIVE";
  constructor(status: PartnerStatus) {
    super(
      status === "paused"
        ? "This partner account is paused; new clients cannot be added"
        : "This partner account is terminated",
    );
  }
}

/**
 * A reseller organisation (docs/29 §2): `active` ⇄ `paused` → `terminated` (final; history
 * is kept). Paused partners keep their tenants and console access but bring in no new business.
 */
export class Partner {
  private constructor(private props: PartnerProps) {}

  static create(params: {
    id: string;
    profile: PartnerProfile;
    referralCode: ReferralCode;
    capabilities: readonly string[];
    now: Date;
  }): Partner {
    return new Partner({
      id: params.id,
      profile: Partner.cleanProfile(params.profile),
      status: "active",
      statusReason: null,
      statusChangedAt: null,
      trusted: false,
      referralCode: params.referralCode.value,
      capabilities: [...new Set(params.capabilities)].sort(),
      createdAt: params.now,
      version: 1,
    });
  }

  static restore(props: PartnerProps): Partner {
    return new Partner(props);
  }

  get id(): string {
    return this.props.id;
  }
  get status(): PartnerStatus {
    return this.props.status;
  }
  get capabilities(): readonly string[] {
    return this.props.capabilities;
  }

  /** Throws unless the partner may bring in new clients. */
  assertCanOnboard(): void {
    if (this.props.status !== "active") throw new PartnerInactiveError(this.props.status);
  }

  update(
    changes: Partial<PartnerProfile> & Readonly<{ trusted?: boolean; referralCode?: ReferralCode }>,
  ): void {
    this.assertNotTerminated();
    const { trusted, referralCode, ...profile } = changes;
    this.props = {
      ...this.props,
      profile: Partner.cleanProfile({ ...this.props.profile, ...profile }),
      trusted: trusted ?? this.props.trusted,
      referralCode: referralCode?.value ?? this.props.referralCode,
    };
  }

  /** Replaces the granted capabilities; returns true when they changed. */
  setCapabilities(capabilities: readonly string[]): boolean {
    this.assertNotTerminated();
    const next = [...new Set(capabilities)].sort();
    if (next.join() === this.props.capabilities.join()) return false;
    this.props = { ...this.props, capabilities: next };
    return true;
  }

  pause(reason: string, now: Date): void {
    if (this.props.status !== "active")
      throw new PartnerStateError(`Cannot pause a partner that is ${this.props.status}`);
    this.changeStatus("paused", reason, now);
  }

  resume(reason: string, now: Date): void {
    if (this.props.status !== "paused")
      throw new PartnerStateError(`Cannot resume a partner that is ${this.props.status}`);
    this.changeStatus("active", reason, now);
  }

  terminate(reason: string, now: Date): void {
    this.assertNotTerminated();
    this.changeStatus("terminated", reason, now);
  }

  snapshot(): PartnerProps {
    return this.props;
  }

  private changeStatus(status: PartnerStatus, reason: string, now: Date): void {
    this.props = { ...this.props, status, statusReason: reason.trim(), statusChangedAt: now };
  }

  private assertNotTerminated(): void {
    if (this.props.status === "terminated")
      throw new PartnerStateError("A terminated partner cannot be changed");
  }

  private static cleanProfile(profile: PartnerProfile): PartnerProfile {
    const optional = (value: string | null) => (value?.trim() ? value.trim() : null);
    return {
      name: profile.name.trim(),
      kind: profile.kind,
      contactName: profile.contactName.trim(),
      email: profile.email.trim().toLowerCase(),
      phone: profile.phone,
      region: optional(profile.region),
      address: optional(profile.address),
      tin: optional(profile.tin),
    };
  }
}
