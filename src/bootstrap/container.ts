import type { AppConfig } from "../shared/config/config.js";

/**
 * Composition root.
 *
 * Every service is created here with plain functions and passed explicitly to the code that
 * needs it — no decorators or reflection (see docs/21_decisions_log.md, decision 62).
 * Later work packages add the logger, database pools, job queue, HTTP app and module wiring.
 */
export type AppContainer = Readonly<{
  config: AppConfig;
}>;

export function createContainer(config: AppConfig): AppContainer {
  return Object.freeze({ config });
}
