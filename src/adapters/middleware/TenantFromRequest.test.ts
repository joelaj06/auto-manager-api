import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { TenantMismatchError } from "../../application/errors/TenantErrors.js";
import { TenantAddressing } from "../../domain/value-objects/TenantAddressing.js";
import { TenantFromRequest } from "./TenantFromRequest.js";

const resolver = new TenantFromRequest({
  addressing: new TenantAddressing({
    webAppUrl: "https://www.example.com",
    baseDomain: "example.com",
  }),
  domains: {
    slugOf: (host) => Promise.resolve(host === "fleet.acme.test" ? "alpha" : null),
    forget: () => undefined,
  },
});

function request(hostname: string, headers: Readonly<Record<string, string>> = {}): Request {
  return { hostname, get: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
}

describe("TenantFromRequest", () => {
  it("reads the business from each of the places that can name it", async () => {
    const api = "api.example.com";
    const cases = [
      request(api, { "x-tenant": "alpha" }),
      request("alpha.example.com"),
      request("fleet.acme.test"),
      request(api, { origin: "https://alpha.example.com" }),
      request(api, { origin: "https://fleet.acme.test" }),
    ];
    for (const req of cases) await expect(resolver.slugOf(req)).resolves.toBe("alpha");
  });

  it("finds none on our own hosts", async () => {
    for (const req of [
      request("api.example.com"),
      request("api.example.com", { origin: "https://admin.example.com" }),
      request("api.example.com", { origin: "https://example.com" }),
      request("api.example.com", { origin: "null" }),
    ])
      await expect(resolver.slugOf(req)).resolves.toBeNull();
  });

  it("accepts places that agree and refuses those that do not", async () => {
    await expect(
      resolver.slugOf(
        request("api.example.com", {
          "x-tenant": "ALPHA",
          origin: "https://alpha.example.com",
        }),
      ),
    ).resolves.toBe("ALPHA");
    for (const req of [
      request("beta.example.com", { "x-tenant": "alpha" }),
      request("api.example.com", { "x-tenant": "alpha", origin: "https://beta.example.com" }),
      request("alpha.example.com", { origin: "https://beta.example.com" }),
    ])
      await expect(resolver.slugOf(req)).rejects.toBeInstanceOf(TenantMismatchError);
  });
});
