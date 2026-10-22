import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IPaymentGateway } from "../../application/ports/IPaymentGateway.js";
import { FakePaymentGateway } from "../../infrastructure/billing/FakePaymentGateway.js";
import { TotpService } from "../../infrastructure/security/TotpService.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures, type TestStaff } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * Paying Autoforce through the gateway (P4-2), with the in-process fake gateway playing the payer
 * and the provider: Paystack-shaped, signed webhooks go through the real HTTP endpoint.
 */
const CONSOLE = "/api/platform/v1";
const PRICE = 30_000;
let container: Container;
let app: Express;
let platform: pg.Pool;
let admin: TestStaff;
let fake: FakePaymentGateway;
let t: ProvisionedTenant;

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const staff = () => as(admin.accessToken);
const owner = () => as(t.ownerAccessToken);
const today = () => new Date().toISOString().slice(0, 10);

/** POSTs a webhook as the provider would (raw body, signature header). */
const deliver = (
  webhook: Readonly<{ body: string; signature: string }>,
  signature = webhook.signature,
) =>
  api()
    .post("/api/v1/webhooks/billing")
    .set("Content-Type", "application/json")
    .set("x-paystack-signature", signature)
    .send(webhook.body);

async function issue(): Promise<{ id: string; totalMinor: number }> {
  const res = await api().post(`${CONSOLE}/tenants/${t.tenantId}/invoices`).set(staff()).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; totalMinor: number };
}

const invoice = async (id: string) =>
  (await api().get(`/api/v1/billing/invoices/${id}`).set(owner())).body.data as {
    status: string;
    outstandingMinor: number;
    payments: { method: string; receiptNumber: string | null; reference: string; id: string }[];
  };

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  fake = container.get<IPaymentGateway>(TYPES.PaymentGateway) as FakePaymentGateway;
  expect(fake).toBeInstanceOf(FakePaymentGateway);
  admin = await new StaffFixtures(container).create(["super_admin"]);
  const code = new TotpService().codeAt(admin.totpSecret, new Date(Date.now() + 30_000));
  await api()
    .post(`${CONSOLE}/auth/step-up`)
    .set(staff())
    .send({ password: admin.password, code })
    .expect(204);
  await api()
    .put(`${CONSOLE}/billing/plans/standard/price`)
    .set(staff())
    .send({ branchPriceMinor: PRICE, reason: "Price list" })
    .expect(200);
  t = await new ProvisionedTenants(container, app, admin).create();
  // The trial is over: invoices start today.
  await platform.query(
    "update subscriptions set trial_ends_at = now() - interval '1 day' where tenant_id = $1",
    [t.tenantId],
  );
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("paying through the gateway", () => {
  let cardPaymentId: string;
  let firstInvoice: string;

  it("pays by hosted checkout: the signed webhook, verified, settles the invoice once", async () => {
    const inv = await issue();
    firstInvoice = inv.id;
    const checkout = await api()
      .post(`/api/v1/billing/invoices/${inv.id}/checkout`)
      .set(owner())
      .send({ saveCard: true });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
    expect(checkout.body.data).toMatchObject({
      status: "pending",
      amountMinor: PRICE,
      checkoutUrl: expect.stringContaining("gateway=fake"),
    });
    const reference = checkout.body.data.reference as string;
    expect(
      (await api().get(`/api/v1/billing/payments/${reference}`).set(owner())).body.data.status,
    ).toBe("pending");

    const webhook = fake.complete(reference, { reusableCard: true });
    const forged = await deliver(webhook, "0".repeat(128));
    expect(forged.status).toBe(401);
    expect((await invoice(inv.id)).status).toBe("open");

    expect((await deliver(webhook)).status).toBe(200);
    expect((await deliver(webhook)).status).toBe(200); // the provider retries: applied once
    const paid = await invoice(inv.id);
    expect(paid).toMatchObject({ status: "paid", outstandingMinor: 0 });
    expect(paid.payments).toHaveLength(1);
    expect(paid.payments[0]).toMatchObject({
      method: "card",
      reference,
      receiptNumber: expect.stringMatching(/^AF-RCT-/),
    });
    cardPaymentId = paid.payments[0]!.id;
    const subscription = await api().get("/api/v1/billing/subscription").set(owner());
    expect(subscription.body.data).toMatchObject({ status: "active", licenceLocked: true });
    const methods = await api().get("/api/v1/billing/payment-methods").set(owner());
    expect(methods.body.data).toEqual([
      expect.objectContaining({ type: "card", label: "Visa •• 4081", isDefault: true }),
    ]);
    const status = await api().get(`/api/v1/billing/payments/${reference}`).set(owner());
    expect(status.body.data).toMatchObject({ status: "succeeded", invoiceStatus: "paid" });

    const inspector = await api().get(`${CONSOLE}/billing/webhooks`).set(staff());
    const outcomes = (inspector.body.data as { outcome: string; signatureValid: boolean }[]).map(
      (w) => [w.outcome, w.signatureValid],
    );
    expect(outcomes).toEqual(
      expect.arrayContaining([
        ["applied", true],
        ["rejected", false],
      ]),
    );
  });

  it("charges the saved card for the next invoice", async () => {
    const inv = await issue();
    const methods = await api().get("/api/v1/billing/payment-methods").set(owner());
    const res = await api()
      .post(`/api/v1/billing/invoices/${inv.id}/pay`)
      .set(owner())
      .send({ paymentMethodId: methods.body.data[0].id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      kind: "saved_card",
      status: "succeeded",
      invoiceStatus: "paid",
    });
  });

  it("pays by mobile money: a voucher, then the prompt, saving the number", async () => {
    const inv = await issue();
    const started = await api()
      .post(`/api/v1/billing/invoices/${inv.id}/momo`)
      .set(owner())
      .send({ phone: "020 123 4567", network: "telecel", save: true });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body.data.next).toMatchObject({ action: "enter_otp" });
    const reference = started.body.data.reference as string;
    const prompt = await api()
      .post(`/api/v1/billing/payments/${reference}/otp`)
      .set(owner())
      .send({ otp: "123456" });
    expect(prompt.body.data.next).toMatchObject({ action: "approve_on_phone" });
    // The payer approves (the development route plays the provider's webhook).
    await api().post(`/api/v1/billing/fake-gateway/${reference}/complete`).set(owner()).expect(204);
    expect((await invoice(inv.id)).status).toBe("paid");
    const methods = await api().get("/api/v1/billing/payment-methods").set(owner());
    expect(methods.body.data.map((m: { label: string }) => m.label)).toContain(
      "Telecel Cash •• 4567",
    );
  });

  it("refunds a gateway payment once the provider confirms, reopening the invoice", async () => {
    const res = await api()
      .post(`${CONSOLE}/billing/payments/${cardPaymentId}/refunds`)
      .set(staff())
      .send({ amountMinor: 10_000, reason: "Charged for a closed branch" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      status: "pending",
      providerRefundId: expect.any(String),
    });
    expect((await invoice(firstInvoice)).status).toBe("paid");
    expect(
      (await deliver(fake.processRefund(res.body.data.providerRefundId as string))).status,
    ).toBe(200);
    expect(await invoice(firstInvoice)).toMatchObject({ status: "open", outstandingMinor: 10_000 });
    const tooMuch = await api()
      .post(`${CONSOLE}/billing/payments/${cardPaymentId}/refunds`)
      .set(staff())
      .send({ amountMinor: PRICE, reason: "Again, too much" });
    expect(tooMuch.body.error.code).toBe("REFUND_NOT_POSSIBLE");
  });

  it("reconciles the day, applying a payment whose webhook was lost", async () => {
    const inv = await issue();
    const checkout = await api()
      .post(`/api/v1/billing/invoices/${inv.id}/checkout`)
      .set(owner())
      .send({});
    fake.complete(checkout.body.data.reference as string); // paid, but the webhook never arrives
    expect((await invoice(inv.id)).status).toBe("open");
    const run = await api()
      .post(`${CONSOLE}/billing/reconciliations`)
      .set(staff())
      .send({ day: today() });
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect(run.body.data).toMatchObject({ status: "matched", missingHere: [], missingThere: [] });
    expect(run.body.data.ourCount).toBe(run.body.data.providerCount);
    expect((await invoice(inv.id)).status).toBe("paid");
  });

  it("holds a payment of the wrong amount for review instead of crediting it", async () => {
    // The open invoice left by the refund.
    const checkout = await api()
      .post(`/api/v1/billing/invoices/${firstInvoice}/checkout`)
      .set(owner())
      .send({});
    const reference = checkout.body.data.reference as string;
    expect((await deliver(fake.complete(reference, { amountMinor: 5_000 }))).status).toBe(200);
    expect(await invoice(firstInvoice)).toMatchObject({ status: "open", outstandingMinor: 10_000 });
    const review = await api()
      .get(`${CONSOLE}/billing/gateway-transactions?status=review`)
      .set(staff());
    expect(review.body.data).toEqual([
      expect.objectContaining({ reference, failureReason: expect.stringMatching(/expected/) }),
    ]);
    const run = await api()
      .post(`${CONSOLE}/billing/reconciliations`)
      .set(staff())
      .send({ day: today() });
    expect(run.body.data.status).toBe("mismatched");
    expect(run.body.data.amountMismatches).toEqual([expect.objectContaining({ reference })]);
  });
});
