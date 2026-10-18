import {
  CONNECT_LINK_VERSION,
  CONNECT_PATH,
  ConnectLinkError,
  connectQuery,
  connectSigningMessage,
  parseConnectLink,
  type ConnectLinkFailure,
  type ConnectPayload,
  type HostAllowList,
} from "../../../domain/mobile/ConnectLink.js";
import { TenantNotFoundForStaffError } from "../../errors/TenantErrors.js";
import type { IClock } from "../../ports/IClock.js";
import type {
  ConnectPublicKey,
  IConnectLinkSigner,
  IQrCodeRenderer,
} from "../../ports/IConnectLinkSigner.js";
import type { ITenantDirectory } from "../../ports/ITenantDirectory.js";

export type MobileAppSettings = Readonly<{
  /** This backend's base URL as the app must call it (ends with "/"). */
  apiBaseUrl: string;
  /** Where links point (the link domain with verified app links), e.g. https://go.example. */
  linkBaseUrl: string;
  /** Custom URL scheme of the app, e.g. "autoforce". */
  scheme: string;
  allowedHosts: HostAllowList;
  android: Readonly<{
    packageName: string | null;
    certSha256: readonly string[];
    storeUrl: string | null;
  }>;
  ios: Readonly<{ appIds: readonly string[]; storeUrl: string | null }>;
  minVersion: string | null;
  latestVersion: string | null;
}>;

export type ConnectLinkView = Readonly<{
  /** HTTPS link (opens the app through app links, or the landing page). Put this in the QR. */
  url: string;
  /** Same parameters on the custom scheme. */
  appUrl: string;
  qrSvg: string;
  tenantSlug: string;
  apiBaseUrl: string;
  keyId: string;
}>;

export type ConnectLinkCheck =
  | Readonly<{
      valid: true;
      payload: ConnectPayload;
      tenant: Readonly<{ id: string; slug: string; status: string }> | null;
      warnings: readonly string[];
    }>
  | Readonly<{ valid: false; reason: ConnectLinkFailure; message: string }>;

export type LandingPage = Readonly<{
  valid: boolean;
  appUrl: string | null;
  androidStoreUrl: string | null;
  iosStoreUrl: string | null;
  tenantSlug: string | null;
}>;

/**
 * Mobile onboarding (docs/23): signed connect links and QR codes, invitation links that open
 * "set your password" in the app, link verification (what the app does, also used for console
 * diagnostics), app-link metadata files and the landing page for phones without the app.
 */
export class MobileConnect {
  constructor(
    private readonly deps: Readonly<{
      signer: IConnectLinkSigner;
      qr: IQrCodeRenderer;
      directory: ITenantDirectory;
      clock: IClock;
      settings: MobileAppSettings;
    }>,
  ) {}

  /** The business's connect link and QR code (portal: Settings → Connect mobile app). */
  async connectLink(tenantId: string): Promise<ConnectLinkView> {
    const tenant = await this.deps.directory.findById(tenantId);
    if (tenant === null) throw new TenantNotFoundForStaffError();
    const payload = this.payload(tenant.slug);
    const query = connectQuery(payload, this.deps.signer.sign(connectSigningMessage(payload)));
    const url = this.httpsLink(query);
    return {
      url,
      appUrl: this.appLink(query),
      qrSvg: await this.deps.qr.svg(url),
      tenantSlug: tenant.slug,
      apiBaseUrl: payload.apiBaseUrl,
      keyId: payload.keyId,
    };
  }

  /** A link that opens the invitation in the app (expires with the invitation). */
  invitationLink(tenantSlug: string, token: string, expiresAt: Date): string {
    const payload: ConnectPayload = {
      ...this.payload(tenantSlug),
      invitationToken: token,
      expiresAt: Math.floor(expiresAt.getTime() / 1_000),
    };
    return this.httpsLink(
      connectQuery(payload, this.deps.signer.sign(connectSigningMessage(payload))),
    );
  }

  /**
   * Everything the app checks before connecting: shape, version, known key, signature, allowed
   * backend host and expiry; plus (here) whether the business exists.
   */
  async verify(link: string): Promise<ConnectLinkCheck> {
    const { signer, settings } = this.deps;
    try {
      const { payload, signature } = parseConnectLink(link, settings.scheme);
      if (!signer.knowsKey(payload.keyId))
        throw new ConnectLinkError("unknown_key", "Signed with a key the app does not trust");
      if (!signer.verify(connectSigningMessage(payload), signature, payload.keyId))
        throw new ConnectLinkError("bad_signature", "The link was changed or not made by us");
      if (!settings.allowedHosts.allowsUrl(payload.apiBaseUrl))
        throw new ConnectLinkError("host_not_allowed", "The link points to an unknown server");
      const now = Math.floor(this.deps.clock.now().getTime() / 1_000);
      if (payload.expiresAt !== undefined && payload.expiresAt < now)
        throw new ConnectLinkError("expired", "This invitation link has expired");
      const tenant = await this.deps.directory.findBySlug(payload.tenantSlug);
      const warnings = [
        ...(tenant === null ? ["No business with this address on this server"] : []),
        ...(payload.apiBaseUrl === settings.apiBaseUrl
          ? []
          : [`Points to ${payload.apiBaseUrl}, not this server (${settings.apiBaseUrl})`]),
      ];
      return {
        valid: true,
        payload,
        tenant:
          tenant === null ? null : { id: tenant.id, slug: tenant.slug, status: tenant.status },
        warnings,
      };
    } catch (error) {
      if (error instanceof ConnectLinkError)
        return { valid: false, reason: error.reason, message: error.message };
      throw error;
    }
  }

  publicKeys(): readonly ConnectPublicKey[] {
    return this.deps.signer.publicKeys();
  }

  /** Android App Links (`/.well-known/assetlinks.json`); null until the app is registered. */
  assetLinks(): unknown[] | null {
    const { android } = this.deps.settings;
    if (android.packageName === null || android.certSha256.length === 0) return null;
    return [
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: android.packageName,
          sha256_cert_fingerprints: android.certSha256,
        },
      },
    ];
  }

  /** iOS Universal Links (`/.well-known/apple-app-site-association`); null until registered. */
  appleAppSiteAssociation(): unknown {
    const { ios } = this.deps.settings;
    if (ios.appIds.length === 0) return null;
    return {
      applinks: {
        details: [
          { appIDs: ios.appIds, components: [{ "/": `${CONNECT_PATH}*`, comment: "Connect" }] },
        ],
      },
    };
  }

  /**
   * What the `/connect` page shows when the app is not installed: buttons to open the app and
   * to get it; the Play Store link carries a connect link as install referrer (docs/23 §7).
   */
  async landingPage(query: string): Promise<LandingPage> {
    const { settings } = this.deps;
    const check = await this.verify(`${settings.linkBaseUrl}${CONNECT_PATH}?${query}`);
    if (!check.valid)
      return {
        valid: false,
        appUrl: null,
        androidStoreUrl: settings.android.storeUrl,
        iosStoreUrl: settings.ios.storeUrl,
        tenantSlug: null,
      };
    const params = new URLSearchParams(query).toString();
    // The store gets a fresh link without any invitation token (never hand tokens to third
    // parties); after installing, the invited user opens their email link again.
    const plain = this.payload(check.payload.tenantSlug);
    const referrer = connectQuery(plain, this.deps.signer.sign(connectSigningMessage(plain)));
    return {
      valid: true,
      appUrl: this.appLink(params),
      androidStoreUrl:
        settings.android.storeUrl === null
          ? null
          : withReferrer(settings.android.storeUrl, referrer),
      iosStoreUrl: settings.ios.storeUrl,
      tenantSlug: check.payload.tenantSlug,
    };
  }

  /** The `app` section of the public tenant-config (force update, store links). */
  appInfo(): Readonly<{
    minVersion: string | null;
    latestVersion: string | null;
    storeUrls: Readonly<{ android: string | null; ios: string | null }>;
  }> {
    const { settings } = this.deps;
    return {
      minVersion: settings.minVersion,
      latestVersion: settings.latestVersion,
      storeUrls: { android: settings.android.storeUrl, ios: settings.ios.storeUrl },
    };
  }

  private payload(tenantSlug: string): ConnectPayload {
    return {
      version: CONNECT_LINK_VERSION,
      apiBaseUrl: this.deps.settings.apiBaseUrl,
      tenantSlug,
      keyId: this.deps.signer.keyId,
    };
  }

  private httpsLink(query: string): string {
    return `${this.deps.settings.linkBaseUrl}${CONNECT_PATH}?${query}`;
  }

  private appLink(query: string): string {
    return `${this.deps.settings.scheme}://connect?${query}`;
  }
}

function withReferrer(storeUrl: string, connectQueryString: string): string {
  const url = new URL(storeUrl);
  url.searchParams.set("referrer", connectQueryString);
  return url.toString();
}
