import type { Request } from "express";
import { TenantMismatchError } from "../../application/errors/TenantErrors.js";
import type { ITenantDomainLookup } from "../../application/ports/ITenantDomains.js";
import type { TenantAddressing } from "../../domain/value-objects/TenantAddressing.js";

export const TENANT_HEADER = "x-tenant";

/**
 * Which business a request addresses. Each of these can name one, and those that do must agree:
 * - the X-Tenant header (the mobile app, API clients);
 * - the host it came to: `<slug>.<base domain>` or a custom domain (a proxied web portal);
 * - the browser's Origin, for a portal on its own address calling the shared `api.<domain>`.
 *
 * None of them proves anything: a client can send any of these, and a bearer token still has to
 * belong to the business addressed.
 */
export class TenantFromRequest {
  constructor(
    private readonly deps: Readonly<{
      addressing: TenantAddressing;
      domains?: ITenantDomainLookup;
    }>,
  ) {}

  async slugOf(req: Request): Promise<string | null> {
    const named = [
      headerSlug(req),
      await this.ofHost(req.hostname),
      await this.ofHost(originHost(req)),
    ].filter((slug) => slug !== null);
    const [first] = named;
    if (first === undefined) return null;
    if (named.some((slug) => slug.toLowerCase() !== first.toLowerCase()))
      throw new TenantMismatchError();
    return first;
  }

  private async ofHost(host: string | null | undefined): Promise<string | null> {
    if (host === null || host === undefined || host === "") return null;
    const domain = await this.deps.domains?.slugOf(host);
    return domain ?? this.deps.addressing.slugOfHost(host);
  }
}

export function headerSlug(req: Request): string | null {
  const value = req.get(TENANT_HEADER);
  return value === undefined || value.trim() === "" ? null : value.trim();
}

function originHost(req: Request): string | null {
  const origin = req.get("origin");
  if (origin === undefined || !URL.canParse(origin)) return null;
  return new URL(origin).hostname;
}
