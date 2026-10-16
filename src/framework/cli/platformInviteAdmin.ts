import { parseArgs } from "node:util";
import { SUPER_ADMIN_ROLE } from "../../application/authorization/platformPermissionCatalog.js";
import type { IPlatformRoles } from "../../application/ports/IPlatformRoles.js";
import type { StaffAdministration } from "../../application/use-cases/platform/StaffAdministration.js";
import { loadConfig } from "../../infrastructure/config/config.js";
import { MigrationSets } from "../../infrastructure/database/migrations/MigrationCatalog.js";
import { createContainer, disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";
import { runCommand } from "./runCommand.js";

/**
 * yarn platform:invite-admin --email <email> --name "<name>"
 *
 * Invites a Super Admin from the server itself: the way to create the first console account,
 * and the recovery path if every Super Admin is locked out. Prints the one-time link (it is also
 * emailed once the worker runs). Audited as a system action.
 */
runCommand("platform:invite-admin", async () => {
  const { values } = parseArgs({
    options: { email: { type: "string" }, name: { type: "string" } },
  });
  if (values.email === undefined || values.name === undefined) {
    console.error('Usage: yarn platform:invite-admin --email <email> --name "<full name>"');
    return 2;
  }

  const config = loadConfig();
  const container = createContainer(
    config,
    await MigrationSets.load(config.database.migrationsDir),
  );
  try {
    const superAdmin = await container
      .get<IPlatformRoles>(TYPES.PlatformRoles)
      .findBySystemKey(SUPER_ADMIN_ROLE);
    if (superAdmin === null) {
      console.error("The Super Admin role does not exist yet. Run `yarn db:migrate` first.");
      return 1;
    }
    const result = await container
      .get<StaffAdministration>(TYPES.StaffAdministration)
      .invite({ email: values.email, name: values.name, roleIds: [superAdmin.id], actor: null });

    const url = `${config.auth.platform.consoleUrl.replace(/\/$/, "")}/accept-invitation#token=${result.invitationToken}`;
    console.info(
      `Invited ${values.email} as Super Admin (expires ${result.expiresAt.toISOString()}).`,
    );
    console.info(`One-time link: ${url}`);
    console.info(`Without the console UI: POST /api/platform/v1/auth/invitations/accept`);
    console.info(
      `  { "token": "${result.invitationToken}", "password": "<at least 12 characters>" }`,
    );
    return 0;
  } finally {
    await disposeContainer(container);
  }
});
