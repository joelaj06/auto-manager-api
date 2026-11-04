import { DomainError } from "../errors/DomainError.js";

export class CustomDomainRuleError extends DomainError {
  readonly code = "CUSTOM_DOMAIN_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const DOMAIN_STATUSES = ["pending", "active", "suspended"] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

/** Domains a tenant may hold. */
export const MAX_TENANT_DOMAINS = 5;
/** Failed daily checks in a row before an active domain is suspended. */
export const DOMAIN_FAILED_CHECKS_LIMIT = 3;
/** The TXT record that proves a domain is the business's. */
export const DOMAIN_CHALLENGE_LABEL = "_autoforce-challenge";
export const DOMAIN_CHALLENGE_PREFIX = "autoforce-verify=";

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A lowercase host name of at least two labels, not one of ours or under one of ours. */
export function checkDomain(value: string, reserved: readonly string[]): string {
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  const labels = domain.split(".");
  const valid =
    domain.length <= 253 &&
    labels.length >= 2 &&
    labels.every((l) => LABEL.test(l)) &&
    !/^\d+$/.test(labels[labels.length - 1]!);
  if (!valid) throw new CustomDomainRuleError("That is not a host name, e.g. fleet.example.com");
  if (reserved.some((r) => domain === r || domain.endsWith(`.${r}`)))
    throw new CustomDomainRuleError("That host name is reserved");
  return domain;
}

/** Whether the TXT values prove the domain is held by the tenant with this token. */
export function challengeAnswered(values: readonly string[], token: string): boolean {
  return values.some((v) => v.trim() === `${DOMAIN_CHALLENGE_PREFIX}${token}`);
}
