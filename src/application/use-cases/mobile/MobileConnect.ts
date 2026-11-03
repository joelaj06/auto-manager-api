import { createHash } from "node:crypto";
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
import { deferredCode, normaliseDeferredCode } from "../../../domain/mobile/DeferredLink.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import { TenantNotFoundForStaffError } from "../../errors/TenantErrors.js";
import type { IClock } from "../../ports/IClock.js";
import type {
  ConnectPublicKey,
  IConnectLinkSigner,
  IQrCodeRenderer,
} from "../../ports/IConnectLinkSigner.js";
import type { IDeferredConnectLinks } from "../../ports/IDeferredConnectLinks.js";
import type { ISecretBox } from "../../ports/ISecretBox.js";
import type { ITenantDirectory } from "../../ports/ITenantDirectory.js";

/** Unknown, used or expired: the same answer for all three (404). */
export class DeferredLinkNotFoundError extends ApplicationError {
  readonly code = "DEFERRED_LINK_NOT_FOUND";
  constructor() {
    super("This code cannot be used; scan the QR code or open your link again");
  }
}

/** A hold lasts a day, and never past the link's own expiry. */
const HOLD_MS = 24 * 3_600_000;

export type DeferredHold = Readonly<{
  /** XXXXX-XXXXX, shown once; only its hash is kept. */
  code: string;
  /** Opens the app on the code; what the page puts on the clipboard. */
  resumeUrl: string;
  iosStoreUrl: string | null;
  expiresAt: Date;
  tenantSlug: string;
}>;

export type DeferredClaim = Readonly<{
  /** The connect link the app handles as if it had been opened. */
  url: string;
  appUrl: string;
  tenantSlug: string;
}>;

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

const hashOf = (code: string | null) =>
  createHash("sha256")
    .update(code ?? "")
    .digest("hex");

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
  /** The link's query, for keeping it through an iPhone install. */
  query?: string;
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
      deferred: IDeferredConnectLinks;
      secrets: ISecretBox;
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
      query: params,
      androidStoreUrl:
        settings.android.storeUrl === null
          ? null
          : withReferrer(settings.android.storeUrl, referrer),
      iosStoreUrl: settings.ios.storeUrl,
      tenantSlug: check.payload.tenantSlug,
    };
  }

  /**
   * Holds a connect link for a phone without the app (docs/23 §7, decision 518): iOS has no install
   * referrer and third-party attribution would hand invitation tokens to someone else, so the link
   * waits here behind a code the person carries through the App Store. Null for a bad link.
   */
  async hold(query: string): Promise<DeferredHold | null> {
    const { deps } = this;
    const { settings } = deps;
    const check = await this.verify(`${settings.linkBaseUrl}${CONNECT_PATH}?${query}`);
    if (!check.valid) return null;
    const now = deps.clock.now();
    const linkEnds =
      check.payload.expiresAt === undefined ? Infinity : check.payload.expiresAt * 1_000;
    const expiresAt = new Date(Math.min(now.getTime() + HOLD_MS, linkEnds));
    const code = deferredCode();
    await deps.deferred.hold({
      codeHash: hashOf(normaliseDeferredCode(code)),
      sealedQuery: deps.secrets.seal(new URLSearchParams(query).toString()),
      tenantSlug: check.payload.tenantSlug,
      expiresAt,
      now,
    });
    return {
      code,
      resumeUrl: this.resumeUrl(code),
      iosStoreUrl: settings.ios.storeUrl,
      expiresAt,
      tenantSlug: check.payload.tenantSlug,
    };
  }

  /** What the page shows for a resume link when the app is still not installed. */
  held(code: string): Pick<DeferredHold, "code" | "resumeUrl" | "iosStoreUrl"> {
    return {
      code,
      resumeUrl: this.resumeUrl(code),
      iosStoreUrl: this.deps.settings.ios.storeUrl,
    };
  }

  /** The app takes the held link, once. */
  async claim(code: string): Promise<DeferredClaim> {
    const { deps } = this;
    const normal = normaliseDeferredCode(code);
    if (normal === null) throw new DeferredLinkNotFoundError();
    const held = await deps.deferred.claim(hashOf(normal), deps.clock.now());
    if (held === null) throw new DeferredLinkNotFoundError();
    const query = deps.secrets.open(held.sealedQuery);
    return {
      url: `${deps.settings.linkBaseUrl}${CONNECT_PATH}?${query}`,
      appUrl: this.appLink(query),
      tenantSlug: held.tenantSlug,
    };
  }

  private resumeUrl(code: string): string {
    const { linkBaseUrl } = this.deps.settings;
    return `${linkBaseUrl}${CONNECT_PATH}?hold=${encodeURIComponent(code)}`;
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
