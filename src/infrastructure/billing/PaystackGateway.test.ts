import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PaymentGatewayError } from "../../application/ports/IPaymentGateway.js";
import { PaystackGateway } from "./PaystackGateway.js";

const SECRET = "sk_test_0123456789abcdef";

type Call = { url: string; method: string; body: unknown; auth: string | null };

/** A Paystack that answers from a script and records what it was asked. */
function stub(answers: readonly unknown[], status = 200) {
  const calls: Call[] = [];
  let i = 0;
  const fetcher = ((url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      auth: new Headers(init?.headers).get("authorization"),
    });
    return Promise.resolve(new Response(JSON.stringify(answers[i++]), { status }));
  }) as typeof fetch;
  return {
    calls,
    gateway: new PaystackGateway({
      secretKey: SECRET,
      baseUrl: "https://api.paystack.test",
      fetch: fetcher,
    }),
  };
}

describe("Paystack gateway", () => {
  it("opens a hosted checkout with the server's amount and our reference", async () => {
    const { gateway, calls } = stub([
      { status: true, data: { authorization_url: "https://checkout.paystack.com/abc" } },
    ]);
    const result = await gateway.initializeCheckout({
      reference: "AF-INV-2026-000001-0a1b2c3d4e",
      amountMinor: 30_000,
      currency: "GHS",
      email: "owner@example.com",
      callbackUrl: "https://app.example/billing/return",
      metadata: { invoiceId: "i1" },
    });
    expect(result.checkoutUrl).toBe("https://checkout.paystack.com/abc");
    expect(calls[0]).toMatchObject({
      url: "https://api.paystack.test/transaction/initialize",
      method: "POST",
      auth: `Bearer ${SECRET}`,
      body: { amount: 30_000, currency: "GHS", reference: "AF-INV-2026-000001-0a1b2c3d4e" },
    });
  });

  it("reads a verified card payment with a reusable authorization", async () => {
    const { gateway } = stub([
      {
        status: true,
        data: {
          id: 4242,
          status: "success",
          reference: "R1",
          amount: 30_000,
          currency: "GHS",
          paid_at: "2026-11-01T09:00:00.000Z",
          channel: "card",
          fees: 585,
          authorization: {
            authorization_code: "AUTH_x1",
            brand: "visa",
            last4: "4081",
            exp_month: "02",
            exp_year: "2028",
            reusable: true,
            channel: "card",
          },
        },
      },
    ]);
    expect(await gateway.verify("R1")).toEqual({
      reference: "R1",
      status: "success",
      amountMinor: 30_000,
      currency: "GHS",
      paidAt: new Date("2026-11-01T09:00:00.000Z"),
      channel: "card",
      providerTransactionId: "4242",
      feesMinor: 585,
      authorization: {
        code: "AUTH_x1",
        label: "Visa •• 4081",
        reusable: true,
        expiresOn: "2028-02-29",
      },
      mobileMoneyLabel: null,
      failureReason: null,
    });
  });

  it("sends Ghana networks with Paystack's codes and reads what the payer must do", async () => {
    const { gateway, calls } = stub([
      { status: true, data: { status: "pay_offline", display_text: "Approve on your phone" } },
      { status: true, data: { status: "send_otp", display_text: "Enter the voucher" } },
    ]);
    const base = {
      reference: "R2",
      email: "o@example.com",
      amountMinor: 100,
      currency: "GHS",
      metadata: {},
    };
    expect(
      await gateway.chargeMobileMoney({ ...base, phone: "0244123456", network: "mtn" }),
    ).toEqual({
      status: "prompt",
      message: "Approve on your phone",
    });
    expect(
      (await gateway.chargeMobileMoney({ ...base, phone: "0201234567", network: "telecel" }))
        .status,
    ).toBe("otp");
    expect(
      calls.map((c) => (c.body as { mobile_money: { provider: string } }).mobile_money.provider),
    ).toEqual(["mtn", "vod"]);
  });

  it("pages through the transaction list for reconciliation", async () => {
    const { gateway, calls } = stub([
      {
        status: true,
        data: [
          {
            reference: "A",
            amount: 100,
            currency: "GHS",
            paid_at: "2026-11-01T10:00:00Z",
            fees: 2,
          },
        ],
        meta: { pageCount: 2 },
      },
      {
        status: true,
        data: [{ reference: "B", amount: 200, currency: "GHS", paid_at: "2026-11-01T11:00:00Z" }],
        meta: { pageCount: 2 },
      },
    ]);
    const list = await gateway.transactions({
      from: new Date("2026-11-01T00:00:00Z"),
      to: new Date("2026-11-02T00:00:00Z"),
    });
    expect(list.map((t) => t.reference)).toEqual(["A", "B"]);
    expect(calls[1]!.url).toContain("page=2");
  });

  it("turns provider refusals and outages into gateway errors", async () => {
    const { gateway } = stub([{ status: false, message: "Invalid key" }], 401);
    await expect(gateway.verify("R")).rejects.toThrow(PaymentGatewayError);
    const down = new PaystackGateway({
      secretKey: SECRET,
      baseUrl: "https://api.paystack.test",
      fetch: () => Promise.reject(new Error("ECONNRESET")),
    });
    await expect(down.verify("R")).rejects.toThrow(/could not be reached/);
  });

  it("checks webhook signatures over the raw body and reads the events we use", () => {
    const { gateway } = stub([]);
    const body = Buffer.from(
      JSON.stringify({ event: "charge.success", data: { id: 7, reference: "R7" } }),
    );
    const signature = createHmac("sha512", SECRET).update(body).digest("hex");
    expect(gateway.verifySignature(body, signature)).toBe(true);
    expect(gateway.verifySignature(Buffer.from(`${body.toString()} `), signature)).toBe(false);
    expect(gateway.verifySignature(body, undefined)).toBe(false);
    expect(gateway.verifySignature(body, "nothex")).toBe(false);
    expect(gateway.parseWebhook(JSON.parse(body.toString()))).toEqual({
      kind: "charge",
      type: "charge.success",
      key: "charge.success:7",
      reference: "R7",
    });
    expect(
      gateway.parseWebhook({
        event: "refund.processed",
        data: { transaction_reference: "R7", refund_reference: "RF1", status: "processed" },
      }),
    ).toMatchObject({ kind: "refund", transactionReference: "R7", status: "processed" });
    expect(gateway.parseWebhook({ event: "subscription.create", data: {} })).toBeNull();
  });
});
