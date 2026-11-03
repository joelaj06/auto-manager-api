import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import type { ITenantArchives } from "../../application/ports/ITenantArchives.js";
import { loadBackupPrivateKey } from "../../infrastructure/backup/BackupCipher.js";
import { loadConfig } from "../../infrastructure/config/config.js";
import { MigrationSets } from "../../infrastructure/database/migrations/MigrationCatalog.js";
import { createContainer, disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";
import { archiveOperationsFrom } from "./archiveOperations.js";
import { runCommand } from "./runCommand.js";

const USAGE = `yarn archive <command>      Cold archives (docs/26 §8, runbook in docs/31)

  list    [--status <status>] [--limit <n>]    Archives, their size, key and last restore test
  verify  --private-key <file>                 Yearly restore test into a scratch database,
          (--id <archive id>... | --due [<n>])  migrated to this release (--due: not tested
                                               for a year, up to n, 10 by default)
  restore --private-key <file> --tenant <id>   Bring a tenant back once its restore was
                                               approved in the console
  rekey   --private-key <file>                 Encrypt archives again for the current public
          (--id <archive id>... | --all)        key (BACKUP_PUBLIC_KEY_FILE) after a rotation

  --operator <name>  who runs it, for the audit log (default: the system user name)`;

const PASSPHRASE_ENV = "BACKUP_PRIVATE_KEY_PASSPHRASE";

/** yarn archive — what an operator holding the backup private key does with cold archives. */
runCommand("archive", async () => {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      "private-key": { type: "string" },
      id: { type: "string", multiple: true },
      due: { type: "string" },
      all: { type: "boolean" },
      tenant: { type: "string" },
      status: { type: "string" },
      limit: { type: "string" },
      operator: { type: "string" },
    },
    allowPositionals: true,
  });
  if (!["list", "verify", "restore", "rekey"].includes(command ?? "")) {
    console.error(USAGE);
    return 2;
  }
  const operator = values.operator ?? userInfo().username;
  const config = loadConfig();
  const container = createContainer(
    config,
    await MigrationSets.load(config.database.migrationsDir),
  );
  try {
    if (command === "list") {
      const archives = await container.get<ITenantArchives>(TYPES.TenantArchives).list({
        ...(values.status === undefined ? {} : { status: values.status as "archived" }),
        limit: Number(values.limit ?? 50),
      });
      if (archives.length === 0) console.info("No archives.");
      for (const a of archives)
        console.info(
          `${a.id}  ${a.slug.padEnd(24)} ${a.status.padEnd(9)} ${a.archivedAt?.toISOString().slice(0, 10) ?? "-"}  ${a.sizeBytes ?? "-"} bytes  key ${a.keyFingerprint?.slice(0, 12) ?? "-"}  tested ${a.lastVerifiedAt?.toISOString().slice(0, 10) ?? "never"}`,
        );
      return 0;
    }

    const operations = archiveOperationsFrom(
      container,
      await readPrivateKey(values["private-key"]),
    );
    switch (command) {
      case "verify": {
        const results = await operations.verify(
          operator,
          values.id === undefined ? { due: Number(values.due ?? 10) } : { archiveIds: values.id },
        );
        if (results.length === 0) console.info("No archive is due its restore test.");
        let failed = 0;
        for (const r of results) {
          const passed = r.report?.passed === true;
          if (!passed) failed++;
          console.info(
            `${passed ? "ok  " : "FAIL"} ${r.slug} (${r.archiveId})${r.error === null ? "" : ` — ${r.error}`}`,
          );
          for (const check of r.report?.checks ?? [])
            console.info(
              `    ${check.passed ? "ok  " : "FAIL"} ${check.name}${check.detail === undefined ? "" : ` — ${check.detail}`}`,
            );
        }
        return failed === 0 ? 0 : 1;
      }
      case "restore": {
        if (values.tenant === undefined) {
          console.error(USAGE);
          return 2;
        }
        const { report, clusterId } = await operations.restore(values.tenant, operator);
        console.info(
          `Restored on ${clusterId}, migrated ${report.schemaVersion ?? "-"} → ${report.migratedTo ?? "-"}. ` +
            "The tenant is deactivated: restore it in the console when the business is ready.",
        );
        return 0;
      }
      default: {
        if (values.id === undefined && values.all !== true) {
          console.error(USAGE);
          return 2;
        }
        const results = await operations.rekey(
          operator,
          values.id === undefined ? {} : { archiveIds: values.id },
        );
        for (const r of results)
          console.info(`${r.error === null ? "ok  " : "FAIL"} ${r.slug} ${r.backupId ?? r.error}`);
        console.info(
          `${results.filter((r) => r.error === null).length} archive(s) encrypted again.`,
        );
        return results.every((r) => r.error === null) ? 0 : 1;
      }
    }
  } finally {
    await disposeContainer(container);
  }
});

async function readPrivateKey(file: string | undefined) {
  if (file === undefined) throw new Error("--private-key <file> is required");
  const pem = await readFile(file, "utf8");
  try {
    return loadBackupPrivateKey(pem, process.env[PASSPHRASE_ENV]);
  } catch (error) {
    throw new Error(`Cannot open the private key ${file}: wrong or missing ${PASSPHRASE_ENV}?`, {
      cause: error,
    });
  }
}
