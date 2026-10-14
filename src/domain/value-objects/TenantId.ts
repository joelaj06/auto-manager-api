import { InvalidTenantIdError } from "../errors/TenantErrors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Immutable identifier of a tenant (a UUID, stored lowercase). */
export class TenantId {
  private constructor(readonly value: string) {}

  static from(value: string): TenantId {
    if (!TenantId.isValid(value)) throw new InvalidTenantIdError();
    return new TenantId(value.toLowerCase());
  }

  static isValid(value: unknown): value is string {
    return typeof value === "string" && UUID_PATTERN.test(value);
  }

  equals(other: TenantId): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
