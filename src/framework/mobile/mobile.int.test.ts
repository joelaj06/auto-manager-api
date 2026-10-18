import { createPublicKey, verify } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IConnectLinkSigner } from "../../application/ports/IConnectLinkSigner.js";
import {
  connectQuery,
  connectSigningMessage,
  parseConnectLink,
  type ConnectPayload,
} from "../../domain/mobile/ConnectLink.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures, type TestStaff } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

const PLAY_STORE = "https://play.google.com/store/apps/details?id=com.autoforce.manager";
const CERT = Array.from({ length: 32 }, () => "AB").join(":");

let container: Container;
let app: Express;
let platform: pg.Pool;
let admin: TestStaff;
let billing: TestStaff;
let t: ProvisionedTenant;
let signer: IConnectLinkSigner;

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const verifyLink = (link: string, staff = admin) =>
  api()
    .post("/api/platform/v1/mobile/connect-links/verify")
    .set(as(staff.accessToken))
    .send({ link });
const signed = (payload: ConnectPayload) =>
  `autoforce://connect?${connectQuery(payload, signer.sign(connectSigningMessage(payload)))}`;

beforeAll(async () => {
  container = await createTestContainer({
    AUTH_RATE_LIMIT_MAX: "10000",
    MOBILE_LINK_BASE_URL: "https://go.autoforce.test",
    MOBILE_ANDROID_STORE_URL: PLAY_STORE,
    MOBILE_ANDROID_PACKAGE: "com.autoforce.manager",
    MOBILE_ANDROID_CERT_SHA256: CERT,
    MOBILE_IOS_APP_IDS: "ABCDE12345.com.autoforce.manager",
    MOBILE_MIN_APP_VERSION: "2.0.0",
    MOBILE_LATEST_APP_VERSION: "2.1.0",
  });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  signer = container.get<IConnectLinkSigner>(TYPES.ConnectLinkSigner);
  const staff = new StaffFixtures(container);
  admin = await staff.create(["super_admin"]);
  billing = await staff.create(["billing"]);
  t = await new ProvisionedTenants(container, app, admin).create();
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("connect link and QR code", () => {
  it("gives the business a signed link and QR code the app can verify with the public key", async () => {
    const res = await api().get("/api/v1/mobile/connect-link").set(as(t.ownerAccessToken));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const link = res.body.data;
    expect(link.url.startsWith("https://go.autoforce.test/connect?v=1&api=")).toBe(true);
    expect(link.appUrl.startsWith("autoforce://connect?v=1&")).toBe(true);
    expect(link.qrSvg.startsWith("<svg")).toBe(true);
    expect(link).toMatchObject({ tenantSlug: t.slug, apiBaseUrl: "http://localhost:3000/" });

    // What the app does: parse, rebuild the signed message, check with the embedded key.
    const keys = await api().get("/api/v1/public/mobile/connect-keys");
    const key = keys.body.data[0] as { keyId: string; publicKey: string };
    const { payload, signature } = parseConnectLink(link.url, "autoforce");
    expect(payload.keyId).toBe(key.keyId);
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: key.publicKey },
      format: "jwk",
    });
    expect(
      verify(
        null,
        Buffer.from(connectSigningMessage(payload)),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);

    const check = await verifyLink(link.url);
    expect(check.body.data).toMatchObject({
      valid: true,
      tenant: { slug: t.slug, status: "trialing" },
      warnings: [],
    });
  });

  it("refuses changed, foreign, unknown-key and expired links", async () => {
    const res = await api().get("/api/v1/mobile/connect-link").set(as(t.ownerAccessToken));
    const tampered = (res.body.data.url as string).replace(`t=${t.slug}`, "t=other-fleet");
    expect((await verifyLink(tampered)).body.data).toMatchObject({
      valid: false,
      reason: "bad_signature",
    });
    const base: ConnectPayload = {
      version: 1,
      apiBaseUrl: "http://localhost:3000/",
      tenantSlug: t.slug,
      keyId: signer.keyId,
    };
    expect(
      (await verifyLink(signed({ ...base, apiBaseUrl: "https://evil.example/" }))).body.data.reason,
    ).toBe("host_not_allowed");
    expect(
      (await verifyLink(signed({ ...base, invitationToken: "a".repeat(43), expiresAt: 1 }))).body
        .data.reason,
    ).toBe("expired");
    expect((await verifyLink(signed({ ...base, keyId: "k-000000000000" }))).body.data.reason).toBe(
      "unknown_key",
    );
    expect((await verifyLink("https://example.com/somewhere")).body.data.reason).toBe("malformed");
    const unknownTenant = await verifyLink(signed({ ...base, tenantSlug: "no-such-fleet" }));
    expect(unknownTenant.body.data.valid).toBe(true);
    expect(unknownTenant.body.data.warnings).toEqual([
      "No business with this address on this server",
    ]);
    expect((await verifyLink(res.body.data.url, billing)).status).toBe(403);
  });
});

describe("invitation links", () => {
  it("emails a signed app link that opens the invitation", async () => {
    const email = `mobile-${randomUUID().slice(0, 8)}@example.com`;
    const branches = await api().get("/api/v1/branches").set(as(t.ownerAccessToken));
    const branch = (branches.body.data as { id: string; isDefault: boolean }[]).find(
      (b) => b.isDefault,
    )!.id;
    const invited = await api()
      .post("/api/v1/users/invitations")
      .set(as(t.ownerAccessToken))
      .send({ name: "Driver One", email, branchIds: [branch] });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    const { rows } = await platform.query<{ body_text: string }>(
      `select body_text from email_deliveries where recipient = $1 and template = 'tenant.user_invitation'
        order by created_at desc limit 1`,
      [email],
    );
    const appUrl = /Open this link on your phone instead: (\S+)/.exec(rows[0]!.body_text)![1]!;
    const check = await verifyLink(appUrl);
    expect(check.body.data.valid, JSON.stringify(check.body)).toBe(true);
    const { payload } = parseConnectLink(appUrl, "autoforce");
    expect(payload.expiresAt).toBeGreaterThan(Date.now() / 1000 + 71 * 3600);

    // The app accepts the invitation with the token from the link.
    const accepted = await api()
      .post("/api/v1/auth/invitations/accept")
      .set("X-Tenant", payload.tenantSlug)
      .send({ token: payload.invitationToken, password: "a long driver passphrase" });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  });
});

describe("landing page and app-link files", () => {
  it("offers to open the app or get it, without passing invitation tokens to the store", async () => {
    const payload: ConnectPayload = {
      version: 1,
      apiBaseUrl: "http://localhost:3000/",
      tenantSlug: t.slug,
      invitationToken: "z".repeat(43),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      keyId: signer.keyId,
    };
    const query = connectQuery(payload, signer.sign(connectSigningMessage(payload)));
    const page = await api().get(`/connect?${query}`);
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.text).toContain("Open in the app");
    expect(page.text).toContain(`autoforce://connect?`);
    const store = /href="(https:\/\/play\.google\.com[^"]+)"/
      .exec(page.text)![1]!
      .replaceAll("&amp;", "&");
    const referrer = new URL(store).searchParams.get("referrer")!;
    expect(referrer).toContain(`t=${t.slug}`);
    expect(referrer).not.toContain("inv=");
    expect(
      (await verifyLink(`https://go.autoforce.test/connect?${referrer}`)).body.data.valid,
    ).toBe(true);

    const bad = await api().get(`/connect?v=1&t=%3Cscript%3E`);
    expect(bad.status).toBe(200);
    expect(bad.text).toContain("This link cannot be used");
    expect(bad.text).not.toContain("<script>");
  });

  it("serves Android and iOS app-link files", async () => {
    const android = await api().get("/.well-known/assetlinks.json");
    expect(android.status).toBe(200);
    expect(android.body[0].target).toEqual({
      namespace: "android_app",
      package_name: "com.autoforce.manager",
      sha256_cert_fingerprints: [CERT],
    });
    const ios = await api().get("/.well-known/apple-app-site-association");
    expect(ios.status).toBe(200);
    expect(ios.headers["content-type"]).toContain("application/json");
    expect(ios.body.applinks.details[0].appIDs).toEqual(["ABCDE12345.com.autoforce.manager"]);
  });

  it("tells the app about versions and stores in the public tenant-config", async () => {
    const res = await api().get(`/api/v1/public/tenant-config?slug=${t.slug}`);
    expect(res.body.data.app).toEqual({
      minVersion: "2.0.0",
      latestVersion: "2.1.0",
      storeUrls: { android: PLAY_STORE, ios: null },
    });
  });
});

describe("without app registration", () => {
  it("answers 404 for the app-link files", async () => {
    const plain = await createTestContainer();
    try {
      const plainApp = plain.get<Express>(TYPES.HttpApp);
      expect((await request(plainApp).get("/.well-known/assetlinks.json")).status).toBe(404);
      expect((await request(plainApp).get("/.well-known/apple-app-site-association")).status).toBe(
        404,
      );
    } finally {
      await disposeContainer(plain);
    }
  });
});
