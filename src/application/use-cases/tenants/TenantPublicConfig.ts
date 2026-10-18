import { TenantId } from "../../../domain/value-objects/TenantId.js";
import { TenantNotFoundError } from "../../errors/TenantErrors.js";
import type { IClock } from "../../ports/IClock.js";
import type { IObjectStorage } from "../../ports/IObjectStorage.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type {
  IOrganisationReader,
  ITenantPublicProfiles,
} from "../../ports/ITenantPublicProfiles.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";

export type TenantPublicConfigView = Readonly<{
  tenant: Readonly<{
    slug: string;
    name: string;
    status: string;
    /** Public URL of the business logo (CDN), or null. */
    logoUrl: string | null;
    /** Present when the tenant is blocked or read-only: what the app shows on its blocking screen. */
    notice: Readonly<{ reasonCategory: string | null; message: string | null }> | null;
  }>;
  currency: Readonly<{ base: string; symbol: string }>;
  auth: Readonly<{ methods: readonly string[]; invitationsOnly: boolean }>;
  /** Mobile app versions (force update) and store links (docs/23 §6). */
  app: AppInfo;
  serverTime: string;
}>;

export type AppInfo = Readonly<{
  minVersion: string | null;
  latestVersion: string | null;
  storeUrls: Readonly<{ android: string | null; ios: string | null }>;
}>;

const SYMBOLS: Readonly<Record<string, string>> = {
  GHS: "₵",
  USD: "$",
  EUR: "€",
  GBP: "£",
  NGN: "₦",
  XOF: "CFA",
};
const NOT_READY = new Set(["provisioning", "provisioning_failed"]);

/**
 * GET /api/v1/public/tenant-config (docs/23 §6): the minimum the mobile app and web portal need to
 * connect to a business and show the right screen — never more (no ids, no contacts). Unknown or
 * not-yet-provisioned tenants get the same generic "not found".
 */
export class TenantPublicConfig {
  constructor(
    private readonly deps: Readonly<{
      profiles: ITenantPublicProfiles;
      tenantContext: ITenantContext;
      unitOfWork: IUnitOfWork;
      organisation: IOrganisationReader;
      storage: IObjectStorage;
      clock: IClock;
      app?: AppInfo;
    }>,
  ) {}

  async get(slug: string): Promise<TenantPublicConfigView> {
    const { deps } = this;
    const profile = await deps.profiles.findBySlug(slug);
    if (profile === null || NOT_READY.has(profile.status) || profile.status === "archived") {
      throw new TenantNotFoundError();
    }
    const organisation = await deps.tenantContext.runAs(TenantId.from(profile.id), () =>
      deps.unitOfWork.run(() => deps.organisation.get()),
    );
    const base = organisation?.baseCurrency ?? "GHS";
    const blocked = profile.status === "deactivated" || profile.status === "read_only";
    return {
      tenant: {
        slug: profile.slug,
        name: organisation?.name ?? profile.name,
        status: profile.status,
        logoUrl:
          organisation?.logoStorageKey === undefined || organisation.logoStorageKey === null
            ? null
            : deps.storage.publicUrl(organisation.logoStorageKey),
        notice: blocked
          ? { reasonCategory: profile.deactivationReason, message: profile.statusMessage }
          : null,
      },
      currency: { base, symbol: SYMBOLS[base] ?? base },
      auth: { methods: ["password"], invitationsOnly: true },
      app: deps.app ?? {
        minVersion: null,
        latestVersion: null,
        storeUrls: { android: null, ios: null },
      },
      serverTime: deps.clock.now().toISOString(),
    };
  }
}
