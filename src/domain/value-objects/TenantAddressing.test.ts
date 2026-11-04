import { describe, expect, it } from "vitest";
import { TenantAddressing } from "./TenantAddressing.js";

const production = new TenantAddressing({
  webAppUrl: "https://www.example.com",
  baseDomain: "example.com",
  ownHosts: ["links.example.com"],
});

describe("TenantAddressing", () => {
  it("builds a business's address from the web app's scheme and port", () => {
    expect(production.urlOf("alpha", "/billing")).toBe("https://alpha.example.com/billing");
    const local = new TenantAddressing({
      webAppUrl: "http://localhost:5174/",
      baseDomain: "localhost",
    });
    expect(local.urlOf("alpha", "/sign#token=abc")).toBe(
      "http://alpha.localhost:5174/sign#token=abc",
    );
  });

  it("reads the slug of a business's host name", () => {
    expect(production.slugOfHost("alpha.example.com")).toBe("alpha");
    expect(production.slugOfHost("ALPHA.Example.com.")).toBe("alpha");
  });

  it.each([
    ["the base domain", "example.com"],
    ["a reserved name", "api.example.com"],
    ["our own host", "links.example.com"],
    ["two levels down", "a-b.alpha.example.com"],
    ["a name too short to be a slug", "ab.example.com"],
    ["another domain", "alpha.example.org"],
    ["a domain that only ends the same", "alpha.notexample.com"],
    ["an address", "127.0.0.1"],
    ["nothing", ""],
  ])("sees no business in %s", (_, host) => {
    expect(production.slugOfHost(host)).toBeNull();
  });

  it("gives the CORS pattern of every business", () => {
    expect(TenantAddressing.originPattern("https://www.example.com", "example.com")).toBe(
      "https://*.example.com",
    );
    expect(TenantAddressing.originPattern("http://localhost:5174", "localhost")).toBe(
      "http://*.localhost:5174",
    );
  });
});
