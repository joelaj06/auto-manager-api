import { describe, expect, it } from "vitest";
import {
  checkKeyExpiry,
  checkWebhookEvents,
  checkWebhookUrl,
  formatApiKey,
  IntegrationRuleError,
  isApiKey,
  nextWebhookAttempt,
  shouldDisableEndpoint,
  tenantOfApiKey,
  WEBHOOK_DISABLE_AFTER_FAILURES,
  WEBHOOK_RETRY_MINUTES,
} from "./Integrations.js";

const TENANT = "0199e1c2-7a3b-7f1e-9a4c-8d2e5f6a7b8c";
const SECRET = "a".repeat(43);
const NOW = new Date("2026-11-04T10:00:00Z");

describe("API keys", () => {
  it("carries the tenant in the key and reads it back", () => {
    const key = formatApiKey(TENANT, SECRET);
    expect(isApiKey(key)).toBe(true);
    expect(tenantOfApiKey(key)).toBe(TENANT);
  });

  it("does not read anything that is not a whole key", () => {
    expect(tenantOfApiKey("afk_abc_def")).toBeNull();
    expect(tenantOfApiKey(`afk_${"z".repeat(32)}_${SECRET}`)).toBeNull();
    expect(tenantOfApiKey(`${formatApiKey(TENANT, SECRET)}x`)).toBeNull();
    expect(isApiKey("eyJhbGciOi")).toBe(false);
  });

  it("issues keys for the future and for two years at most", () => {
    expect(() => checkKeyExpiry(null, NOW)).not.toThrow();
    expect(() => checkKeyExpiry(new Date("2027-11-04T10:00:00Z"), NOW)).not.toThrow();
    expect(() => checkKeyExpiry(new Date("2026-11-03T10:00:00Z"), NOW)).toThrow(
      IntegrationRuleError,
    );
    expect(() => checkKeyExpiry(new Date("2029-11-04T10:00:00Z"), NOW)).toThrow(
      IntegrationRuleError,
    );
  });
});

describe("webhook addresses", () => {
  it("takes a public https address", () => {
    expect(checkWebhookUrl("https://hooks.example.com/in?x=1#top")).toBe(
      "https://hooks.example.com/in?x=1",
    );
    expect(checkWebhookUrl("https://hooks.example.com:8443/in")).toBe(
      "https://hooks.example.com:8443/in",
    );
  });

  it.each([
    "http://hooks.example.com/in",
    "https://user:pw@hooks.example.com/in",
    "https://127.0.0.1/in",
    "https://10.0.0.8/in",
    "https://[::1]/in",
    "https://localhost/in",
    "https://metadata.google.internal/computeMetadata",
    "https://printer.local/in",
    "https://hooks/in",
    "https://hooks.example.com:22/in",
    "not an address",
  ])("refuses %s", (url) => {
    expect(() => checkWebhookUrl(url)).toThrow(IntegrationRuleError);
  });

  it("takes only events in the catalogue", () => {
    expect(checkWebhookEvents(["vehicle.created", "vehicle.created"])).toEqual(["vehicle.created"]);
    expect(() => checkWebhookEvents([])).toThrow(IntegrationRuleError);
    expect(() => checkWebhookEvents(["user.invited"])).toThrow(IntegrationRuleError);
  });
});

describe("webhook retries", () => {
  it("backs off, then gives up", () => {
    expect(nextWebhookAttempt(1, NOW)).toEqual(new Date("2026-11-04T10:01:00Z"));
    expect(nextWebhookAttempt(2, NOW)).toEqual(new Date("2026-11-04T10:05:00Z"));
    expect(nextWebhookAttempt(WEBHOOK_RETRY_MINUTES.length, NOW)).toEqual(
      new Date("2026-11-05T10:00:00Z"),
    );
    expect(nextWebhookAttempt(WEBHOOK_RETRY_MINUTES.length + 1, NOW)).toBeNull();
  });

  it("switches off an address only when it has failed many times over days", () => {
    const base = { lastSuccessAt: null, createdAt: new Date("2026-10-01T00:00:00Z") };
    const many = WEBHOOK_DISABLE_AFTER_FAILURES;
    expect(shouldDisableEndpoint({ ...base, consecutiveFailures: many - 1 }, NOW)).toBe(false);
    expect(shouldDisableEndpoint({ ...base, consecutiveFailures: many }, NOW)).toBe(true);
    expect(
      shouldDisableEndpoint(
        { ...base, consecutiveFailures: many, lastSuccessAt: new Date("2026-11-03T00:00:00Z") },
        NOW,
      ),
    ).toBe(false);
  });
});
