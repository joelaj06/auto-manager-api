import { describe, expect, it } from "vitest";
import { JsonLogger, type LogEntry } from "./JsonLogger.js";
import { formatPretty } from "./prettySink.js";
import { REDACTED } from "./redaction.js";

function capture(level: ConstructorParameters<typeof JsonLogger>[0]["level"] = "debug") {
  const entries: LogEntry[] = [];
  const logger = new JsonLogger({
    level,
    sink: (entry) => entries.push(entry),
    now: () => new Date("2026-10-14T12:00:00.000Z"),
  });
  return { logger, entries };
}

describe("JsonLogger", () => {
  it("writes structured entries with time, level and message", () => {
    const { logger, entries } = capture();
    logger.info("Server started", { port: 3000 });
    expect(entries).toEqual([
      { time: "2026-10-14T12:00:00.000Z", level: "info", msg: "Server started", port: 3000 },
    ]);
  });

  it("drops entries below the configured level", () => {
    const { logger, entries } = capture("warn");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(entries.map((e) => e.level)).toEqual(["warn", "error"]);
  });

  it("logs nothing when silent", () => {
    const { logger, entries } = capture("silent");
    logger.error("e");
    expect(entries).toHaveLength(0);
  });

  it("redacts sensitive keys at any depth", () => {
    const { logger, entries } = capture();
    logger.info("login", {
      email: "kofi@example.com",
      password: "hunter2",
      headers: { Authorization: "Bearer abc", "x-request-id": "r1" },
      nested: [{ refreshToken: "t", otp: "123456", apiKey: "k" }],
    });
    expect(entries[0]).toMatchObject({
      email: "kofi@example.com",
      password: REDACTED,
      headers: { Authorization: REDACTED, "x-request-id": "r1" },
      nested: [{ refreshToken: REDACTED, otp: REDACTED, apiKey: REDACTED }],
    });
    expect(JSON.stringify(entries)).not.toMatch(/hunter2|Bearer abc|123456/);
  });

  it("masks credentials inside connection strings and error messages", () => {
    const { logger, entries } = capture();
    logger.error("db failed", {
      url: "postgres://migrator:s3cret@db:5432/autoforce",
      error: new Error("connect to postgresql://app:pw123@host failed"),
    });
    const text = JSON.stringify(entries);
    expect(text).not.toMatch(/s3cret|pw123/);
    expect(text).toContain("postgres://migrator:[REDACTED]@db:5432/autoforce");
  });

  it("serialises errors with code, stack and cause", () => {
    const { logger, entries } = capture();
    const cause = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    logger.error("failed", { error: new Error("outer", { cause }) });
    expect(entries[0]?.error).toMatchObject({
      name: "Error",
      message: "outer",
      stack: expect.stringContaining("outer"),
      cause: { message: "ECONNREFUSED", code: "ECONNREFUSED" },
    });
  });

  it("survives circular references", () => {
    const { logger, entries } = capture();
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    logger.info("circular", { a });
    expect(entries[0]?.a).toEqual({ name: "a", self: "[Circular]" });
  });

  it("merges request context, child bindings and entry context in that order", () => {
    const entries: LogEntry[] = [];
    const logger = new JsonLogger({
      level: "info",
      sink: (entry) => entries.push(entry),
      contextProvider: () => ({ requestId: "req-1", module: "from-context" }),
    }).child({ module: "rentals" });

    logger.info("hello", { extra: true });
    expect(entries[0]).toMatchObject({ requestId: "req-1", module: "rentals", extra: true });
  });

  it("never lets entry context override time, level or msg", () => {
    const { logger, entries } = capture();
    logger.info("real", { msg: "fake", level: "error", time: "never" });
    expect(entries[0]).toMatchObject({
      msg: "real",
      level: "info",
      time: "2026-10-14T12:00:00.000Z",
    });
  });

  it("does not throw when the sink fails", () => {
    const logger = new JsonLogger({
      level: "info",
      sink: () => {
        throw new Error("disk full");
      },
    });
    expect(() => logger.info("x")).not.toThrow();
  });
});

describe("formatPretty", () => {
  it("renders a readable line with fields and the error stack", () => {
    const line = formatPretty({
      time: "2026-10-14T12:00:00.000Z",
      level: "error",
      msg: "Request failed",
      status: 500,
      path: "/api/v1/x",
      error: { message: "boom", stack: "Error: boom\n    at x" },
    });
    expect(line).toContain("12:00:00.000 ERROR Request failed status=500 path=/api/v1/x");
    expect(line).toContain("Error: boom\n    at x");
  });
});
