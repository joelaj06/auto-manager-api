import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { ILogger } from "../../application/ports/ILogger.js";
import { installSignalHandlers } from "./installSignalHandlers.js";
import { ShutdownManager } from "./ShutdownManager.js";

const logger: ILogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

describe("ShutdownManager", () => {
  it("runs hooks in reverse registration order", async () => {
    const order: string[] = [];
    const manager = new ShutdownManager(logger, 1_000);
    manager.register("database", () => Promise.resolve(void order.push("database")));
    manager.register("http", () => Promise.resolve(void order.push("http")));

    expect(await manager.shutdown("test")).toBe(true);
    expect(order).toEqual(["http", "database"]);
  });

  it("keeps going after a failing hook and reports an unclean shutdown", async () => {
    const ran: string[] = [];
    const manager = new ShutdownManager(logger, 1_000);
    manager.register("database", () => Promise.resolve(void ran.push("database")));
    manager.register("http", () => Promise.reject(new Error("boom")));

    expect(await manager.shutdown("test")).toBe(false);
    expect(ran).toEqual(["database"]);
  });

  it("abandons a hanging hook when the timeout runs out", async () => {
    const manager = new ShutdownManager(logger, 50);
    manager.register("hang", () => new Promise<void>(() => undefined));

    const started = Date.now();
    expect(await manager.shutdown("test")).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("returns the same result when called twice", async () => {
    const hook = vi.fn(() => sleep(5));
    const manager = new ShutdownManager(logger, 1_000);
    manager.register("once", hook);

    const [a, b] = await Promise.all([manager.shutdown("one"), manager.shutdown("two")]);
    expect([a, b]).toEqual([true, true]);
    expect(hook).toHaveBeenCalledOnce();
    expect(() => manager.register("late", () => Promise.resolve())).toThrow();
  });
});

describe("installSignalHandlers", () => {
  function fakeProcess() {
    const emitter = new EventEmitter();
    const exit = vi.fn();
    return { proc: { on: emitter.on.bind(emitter), exit } as never, emitter, exit };
  }

  it("shuts down on SIGTERM and exits 0 when clean", async () => {
    const { proc, emitter, exit } = fakeProcess();
    const manager = new ShutdownManager(logger, 1_000);
    installSignalHandlers(manager, logger, proc);

    emitter.emit("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("exits 1 after an uncaught exception", async () => {
    const { proc, emitter, exit } = fakeProcess();
    const manager = new ShutdownManager(logger, 1_000);
    installSignalHandlers(manager, logger, proc);

    emitter.emit("uncaughtException", new Error("bug"));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it("forces exit on a second signal", () => {
    const { proc, emitter, exit } = fakeProcess();
    const manager = new ShutdownManager(logger, 1_000);
    manager.register("hang", () => new Promise<void>(() => undefined));
    installSignalHandlers(manager, logger, proc);

    emitter.emit("SIGINT");
    emitter.emit("SIGINT");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
