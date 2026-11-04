import { describe, expect, it } from "vitest";
import { signWebhook } from "../../application/use-cases/integrations/Webhooks.js";
import {
  HttpsWebhookTransport,
  isPrivateAddress,
  publicOnlyLookup,
} from "./HttpsWebhookTransport.js";

const lookup = (addresses: readonly string[], all = false) =>
  new Promise<unknown>((resolve, reject) => {
    publicOnlyLookup((_host, callback) =>
      callback(
        null,
        addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
      ),
    )("hooks.example.com", { all }, (error, address) =>
      error === null ? resolve(address) : reject(error),
    );
  });

describe("webhook connections", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "not-an-address",
  ])("treats %s as private", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "41.66.0.1", "2001:4860:4860::8888", "::ffff:8.8.8.8"])(
    "treats %s as public",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );

  it("answers with a public address", async () => {
    await expect(lookup(["8.8.8.8"])).resolves.toBe("8.8.8.8");
    await expect(lookup(["8.8.8.8"], true)).resolves.toEqual([{ address: "8.8.8.8", family: 4 }]);
  });

  it("refuses a name when any of its addresses is private", async () => {
    await expect(lookup(["8.8.8.8", "10.0.0.1"])).rejects.toThrow("not a public address");
  });

  it("never reaches this machine, whatever the address says", async () => {
    const transport = new HttpsWebhookTransport();
    const name = await transport.post("https://localhost:1/in", {}, "{}");
    expect(name).toEqual({ status: null, error: "localhost is not a public address" });
    const ip = await transport.post("https://127.0.0.1:1/in", {}, "{}");
    expect(ip.status).toBeNull();
    expect(ip.error).toBe("Only host names are called");
    const plain = await transport.post("http://example.com/in", {}, "{}");
    expect(plain.error).toBe("Only https addresses are called");
  });
});

describe("webhook signatures", () => {
  it("signs the time and the body, as a receiver can check", () => {
    // echo -n '1700000000.{"a":1}' | openssl dgst -sha256 -hmac whsec_test
    expect(signWebhook("whsec_test", '{"a":1}', 1_700_000_000)).toMatch(
      /^t=1700000000,v1=[0-9a-f]{64}$/,
    );
    expect(signWebhook("whsec_test", '{"a":1}', 1_700_000_000)).not.toBe(
      signWebhook("whsec_test", '{"a":2}', 1_700_000_000),
    );
    expect(signWebhook("whsec_test", '{"a":1}', 1_700_000_000)).not.toBe(
      signWebhook("whsec_test", '{"a":1}', 1_700_000_001),
    );
  });
});
