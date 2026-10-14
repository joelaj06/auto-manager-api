import { ConfigError } from "../../infrastructure/config/config.js";

/** Runs a CLI command: prints errors without stack noise for config problems, sets exit code. */
export function runCommand(name: string, command: () => Promise<number>): void {
  command()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      if (error instanceof ConfigError) {
        console.error(error.message);
      } else {
        console.error(`${name} failed:`, error instanceof Error ? error.message : error);
        if (error instanceof Error && error.cause !== undefined) {
          console.error(
            "  cause:",
            error.cause instanceof Error ? error.cause.message : error.cause,
          );
        }
      }
      process.exitCode = 1;
    });
}

export const log = (message: string) => console.info(`  ${message}`);
