import { describe, expect, it, vi } from "vitest";
import type { ILogger } from "../ports/ILogger.js";
import type { IReadinessCheck } from "../ports/IReadinessCheck.js";
import { ReadinessService } from "./ReadinessService.js";

function fakeLogger(): ILogger & { warn: ReturnType<typeof vi.fn> } {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

const check = (name: string, impl: () => Promise<void>): IReadinessCheck => ({ name, check: impl });

describe("ReadinessService", () => {
  it("is ready when every check passes", async () => {
    const service = new ReadinessService(
      [check("database", () => Promise.resolve()), check("cache", () => Promise.resolve())],
      fakeLogger(),
    );
    const report = await service.report();
    expect(report.ready).toBe(true);
    expect(report.checks.map((c) => [c.name, c.status])).toEqual([
      ["database", "up"],
      ["cache", "up"],
    ]);
  });

  it("is not ready when a check fails, and logs (but does not return) the reason", async () => {
    const logger = fakeLogger();
    const service = new ReadinessService(
      [check("database", () => Promise.reject(new Error("password authentication failed")))],
      logger,
    );
    const report = await service.report();

    expect(report).toEqual({
      ready: false,
      checks: [{ name: "database", status: "down", durationMs: expect.any(Number) }],
    });
    expect(JSON.stringify(report)).not.toContain("password");
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("treats a hanging check as down after the timeout", async () => {
    const service = new ReadinessService(
      [check("slow", () => new Promise<void>(() => undefined))],
      fakeLogger(),
      20,
    );
    const report = await service.report();
    expect(report.checks[0]?.status).toBe("down");
  });

  it("is ready with no checks", async () => {
    expect((await new ReadinessService([], fakeLogger()).report()).ready).toBe(true);
  });
});
