import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("applies safe defaults for non-sensitive settings", () => {
    const config = loadConfig({});

    expect(config).toEqual({
      env: "development",
      isProduction: false,
      port: 3000,
      logLevel: "info",
    });
  });

  it("reads and coerces values from the environment", () => {
    const config = loadConfig({ NODE_ENV: "production", PORT: "8080", LOG_LEVEL: "warn" });

    expect(config.env).toBe("production");
    expect(config.isProduction).toBe(true);
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe("warn");
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(loadConfig({}))).toBe(true);
  });

  it("reports every invalid variable by name", () => {
    const attempt = () => loadConfig({ NODE_ENV: "staging", PORT: "not-a-port" });

    expect(attempt).toThrow(ConfigError);
    try {
      attempt();
    } catch (error) {
      const { issues } = error as ConfigError;
      expect(issues).toHaveLength(2);
      expect(issues.some((issue) => issue.startsWith("NODE_ENV:"))).toBe(true);
      expect(issues.some((issue) => issue.startsWith("PORT:"))).toBe(true);
    }
  });

  it("never echoes the rejected value in the error message", () => {
    const secretLookingValue = "s3cr3t-value-that-must-not-leak";

    let message = "";
    try {
      loadConfig({ LOG_LEVEL: secretLookingValue });
    } catch (error) {
      message = (error as ConfigError).message;
    }

    expect(message).toContain("LOG_LEVEL");
    expect(message).not.toContain(secretLookingValue);
  });

  it("rejects out-of-range ports", () => {
    expect(() => loadConfig({ PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: "0" })).toThrow(ConfigError);
  });
});
