import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type pg from "pg";
import {
  keyFingerprint,
  loadBackupPrivateKey,
  loadBackupPublicKey,
} from "../../infrastructure/backup/BackupCipher.js";
import { DatabaseBackupService } from "../../infrastructure/backup/DatabaseBackupService.js";
import { LocalBackupStorage } from "../../infrastructure/backup/LocalBackupStorage.js";
import { PgClientTools } from "../../infrastructure/backup/PgClientTools.js";
import { PostgresBackupCatalog } from "../../infrastructure/backup/PostgresBackupCatalog.js";
import { loadConfig } from "../../infrastructure/config/config.js";
import { MigrationSets } from "../../infrastructure/database/migrations/MigrationCatalog.js";
import type { PostgresConnectionFactory } from "../../infrastructure/database/postgres/PostgresConnectionFactory.js";
import type { TenantDatabaseNaming } from "../../infrastructure/database/postgres/TenantDatabaseNaming.js";
import { createContainer, disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";
import { log, runCommand } from "./runCommand.js";

const USAGE = `yarn backup <command>

  keygen  --out <dir>                       Create the backup key pair (private key encrypted with
                                            BACKUP_PRIVATE_KEY_PASSPHRASE). Keep the private key OFF
                                            the server; set BACKUP_PUBLIC_KEY_FILE to the public key.
  run     [--platform] [--tenant <id>]...   Back up the platform DB and/or tenants
          [--all-tenants]                   (no option: platform + all tenants)
  verify  --private-key <file>              Automated restore test into a scratch database
          (--id <backup id> | --sample <n>) (--sample: latest platform + n random tenants)
  restore --private-key <file> --id <id>    Restore into a NEW database (never overwrites)
          --into <database>
  list    [--limit <n>]                     Recent backups and their verification status`;

const PASSPHRASE_ENV = "BACKUP_PRIVATE_KEY_PASSPHRASE";

/** yarn backup — logical backups, restore test and restores (docs/26, runbooks in docs/31). */
runCommand("backup", async () => {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      out: { type: "string" },
      platform: { type: "boolean" },
      tenant: { type: "string", multiple: true },
      "all-tenants": { type: "boolean" },
      "private-key": { type: "string" },
      id: { type: "string" },
      sample: { type: "string" },
      into: { type: "string" },
      limit: { type: "string" },
    },
  });

  if (command === "keygen") return keygen(values.out);
  if (!["run", "verify", "restore", "list"].includes(command ?? "")) {
    console.error(USAGE);
    return 2;
  }

  const config = loadConfig();
  const container = createContainer(
    config,
    await MigrationSets.load(config.database.migrationsDir),
  );
  try {
    const catalog = new PostgresBackupCatalog(container.get<pg.Pool>(TYPES.PlatformDatabasePool));
    const service = new DatabaseBackupService({
      connections: container.get<PostgresConnectionFactory>(TYPES.PostgresConnectionFactory),
      naming: container.get<TenantDatabaseNaming>(TYPES.TenantDatabaseNaming),
      tools: new PgClientTools(config.backup.pgTools),
      storage: new LocalBackupStorage(config.backup.directory),
      catalog,
      platformDatabase: config.database.platformDatabase,
      tenantTemplateDatabase: config.database.tenantTemplateDatabase,
      publicKey: command === "run" ? await readPublicKey(config.backup.publicKeyFile) : null,
      log,
    });

    switch (command) {
      case "run": {
        const all = !values.platform && values.tenant === undefined && !values["all-tenants"];
        let failures = 0;
        if (all || values.platform) {
          console.info("Backing up the platform database…");
          await service.backupPlatform();
        }
        for (const tenantId of values.tenant ?? []) {
          console.info(`Backing up tenant ${tenantId}…`);
          await service.backupTenant(tenantId);
        }
        if (all || values["all-tenants"]) {
          console.info("Backing up all tenants…");
          const result = await service.backupAllTenants(config.backup.concurrency);
          console.info(`  ${result.succeeded} succeeded, ${result.failed.length} failed`);
          for (const failure of result.failed)
            console.error(`  ${failure.tenantId}: ${failure.error}`);
          failures = result.failed.length;
        }
        return failures === 0 ? 0 : 1;
      }

      case "verify": {
        const privateKey = await readPrivateKey(values["private-key"]);
        const ids =
          values.id !== undefined
            ? [values.id]
            : (await catalog.sampleForVerification(Number(values.sample ?? 3))).map((b) => b.id);
        if (ids.length === 0) {
          console.error("No successful backups to verify.");
          return 1;
        }
        let failed = 0;
        for (const id of ids) {
          const report = await service.verify(id, privateKey);
          for (const check of report.checks) {
            console.info(
              `    ${check.passed ? "ok  " : "FAIL"} ${check.name}${check.detail === undefined ? "" : ` — ${check.detail}`}`,
            );
          }
          if (!report.passed) failed++;
        }
        console.info(`${ids.length - failed} of ${ids.length} backup(s) passed the restore test.`);
        return failed === 0 ? 0 : 1;
      }

      case "restore": {
        if (values.id === undefined || values.into === undefined) {
          console.error(USAGE);
          return 2;
        }
        await service.restore(values.id, await readPrivateKey(values["private-key"]), values.into);
        console.info(
          `Restored into ${values.into}. Check it, then follow docs/31 to switch over or copy rows back.`,
        );
        return 0;
      }

      default: {
        const backups = await catalog.recent(Number(values.limit ?? 20));
        if (backups.length === 0) console.info("No backups yet.");
        for (const b of backups) {
          const target = b.kind === "tenant" ? `tenant ${b.tenantId}` : "platform";
          const verified =
            b.verification === null
              ? "not verified"
              : b.verification.passed === true
                ? `verified ${b.verifiedAt?.toISOString()}`
                : "VERIFICATION FAILED";
          console.info(
            `${b.id}  ${b.startedAt.toISOString()}  ${b.status.padEnd(9)} ${target}  ${b.sizeBytes ?? "-"} bytes  ${verified}`,
          );
        }
        return 0;
      }
    }
  } finally {
    await disposeContainer(container);
  }
});

async function keygen(out: string | undefined): Promise<number> {
  const passphrase = process.env[PASSPHRASE_ENV];
  if (out === undefined || passphrase === undefined || passphrase.length < 12) {
    console.error(`keygen needs --out <dir> and ${PASSPHRASE_ENV} (at least 12 characters).`);
    return 2;
  }
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase },
  });
  await mkdir(out, { recursive: true, mode: 0o700 });
  const privatePath = join(out, "autoforce.backup-key.pem");
  const publicPath = join(out, "autoforce-backup-public.pem");
  // "wx": never overwrite an existing key — backups encrypted for it would become unreadable.
  await writeFile(privatePath, privateKey, { mode: 0o600, flag: "wx" });
  await writeFile(publicPath, publicKey, { mode: 0o644, flag: "wx" });
  console.info(`Private key: ${privatePath}  (keep offline, two people hold copies)`);
  console.info(`Public key:  ${publicPath}  (set BACKUP_PUBLIC_KEY_FILE to this file)`);
  console.info(`Fingerprint: ${keyFingerprint(loadBackupPublicKey(publicKey))}`);
  return 0;
}

async function readPublicKey(file: string | undefined) {
  if (file === undefined) throw new Error("BACKUP_PUBLIC_KEY_FILE is required to create backups");
  return loadBackupPublicKey(await readFile(file, "utf8"));
}

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
