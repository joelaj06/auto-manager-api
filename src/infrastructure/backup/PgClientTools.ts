import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { ConnectionSettings } from "../database/postgres/PostgresConnectionFactory.js";

export type PgToolsSettings = Readonly<{
  /** `local`: pg_dump / pg_restore from the PATH. `docker`: run them from `image`. */
  mode: "local" | "docker";
  image: string;
}>;

type Tool = "pg_dump" | "pg_restore";

export class PgToolError extends Error {
  constructor(
    readonly tool: Tool,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`${tool} failed (exit ${exitCode ?? "signal"}): ${stderr.trim().slice(-2_000)}`);
    this.name = "PgToolError";
  }
}

/** A running tool: its output or input stream and a promise for its exit. */
export type RunningTool<S extends "stdout" | "stdin"> = Readonly<{
  stream: S extends "stdout" ? Readable : Writable;
  exited: Promise<void>;
}>;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Runs the PostgreSQL client tools. The tools must be at least the server's major version, so
 * the Docker mode uses the same image as the server (`postgres:18-alpine`).
 *
 * Passwords travel in the environment (PGPASSWORD), never on the command line where other
 * processes could read them.
 */
export class PgClientTools {
  constructor(private readonly settings: PgToolsSettings) {}

  /** `pg_dump -Fc` of the whole database to stdout; `snapshot` pins it to an exported snapshot. */
  dump(target: ConnectionSettings, options: { snapshot?: string } = {}): RunningTool<"stdout"> {
    const args = ["--format=custom", "--compress=6", "--no-password"];
    if (options.snapshot !== undefined) args.push(`--snapshot=${options.snapshot}`);
    const child = this.start("pg_dump", target, args, ["ignore", "pipe", "pipe"]);
    return { stream: child.stdout as Readable, exited: this.exited("pg_dump", child) };
  }

  /**
   * `pg_restore` from stdin into an existing, empty database, all or nothing. Objects become
   * owned by the connecting role (the migrator).
   */
  restore(target: ConnectionSettings): RunningTool<"stdin"> {
    const args = ["--no-owner", "--exit-on-error", "--single-transaction", "--no-password"];
    const child = this.start("pg_restore", target, args, ["pipe", "ignore", "pipe"]);
    return { stream: child.stdin as Writable, exited: this.exited("pg_restore", child) };
  }

  private start(
    tool: Tool,
    target: ConnectionSettings,
    toolArgs: string[],
    stdio: StdioOptions,
  ): ChildProcess {
    if (target.ssl === "verify-full") {
      // The CA file would have to be mounted into the tools container; use local tools there.
      if (this.settings.mode === "docker") {
        throw new Error("DATABASE_SSL=verify-full needs BACKUP_PG_TOOLS=local");
      }
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PGPASSWORD: target.password,
      PGSSLMODE: target.ssl,
      ...(target.sslCaFile === undefined ? {} : { PGSSLROOTCERT: target.sslCaFile }),
    };
    const local = this.settings.mode === "local";
    const host = !local && LOCAL_HOSTS.has(target.host) ? "host.docker.internal" : target.host;
    const connection = [
      `--host=${host}`,
      `--port=${target.port}`,
      `--username=${target.user}`,
      `--dbname=${target.database}`,
    ];

    const [command, args] = local
      ? [tool, [...connection, ...toolArgs]]
      : [
          "docker",
          [
            "run",
            "--rm",
            "-i",
            "--add-host=host.docker.internal:host-gateway",
            // Names only: docker copies the values from this process's environment.
            "-e",
            "PGPASSWORD",
            "-e",
            "PGSSLMODE",
            this.settings.image,
            tool,
            ...connection,
            ...toolArgs,
          ],
        ];
    return spawn(command, args, { env, stdio });
  }

  private exited(tool: Tool, child: ChildProcess): Promise<void> {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => {
      stderr = (stderr + text).slice(-8_000);
    });
    return new Promise((resolve, reject) => {
      child.once("error", (error: Error) => reject(error));
      child.once("close", (code: number | null) => {
        if (code === 0) resolve();
        else reject(new PgToolError(tool, code, stderr));
      });
    });
  }
}
