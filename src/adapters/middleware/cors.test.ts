import { describe, expect, it } from "vitest";
import { isOriginAllowed } from "./cors.js";

const allowList = [
  "https://admin.autoforce.app",
  "https://*.autoforce.app",
  "http://localhost:5173",
];

describe("isOriginAllowed", () => {
  it.each([
    "https://admin.autoforce.app",
    "https://acme-fleet.autoforce.app",
    "https://a.b.autoforce.app",
    "HTTPS://ACME.AUTOFORCE.APP",
    "http://localhost:5173",
  ])("allows %s", (origin) => {
    expect(isOriginAllowed(origin, allowList)).toBe(true);
  });

  it.each([
    "https://autoforce.app", // apex is not a subdomain
    "http://acme.autoforce.app", // wrong scheme
    "https://acme.autoforce.app.evil.com",
    "https://evilautoforce.app",
    "https://acme.autoforce.app:8443", // different port
    "http://localhost:3000",
    "null",
  ])("rejects %s", (origin) => {
    expect(isOriginAllowed(origin, allowList)).toBe(false);
  });

  it("allows nothing with an empty list", () => {
    expect(isOriginAllowed("https://admin.autoforce.app", [])).toBe(false);
  });
});
