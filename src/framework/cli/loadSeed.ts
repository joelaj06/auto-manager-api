import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { parseArgs } from "node:util";
import request from "supertest";
import { loadConfig } from "../../infrastructure/config/config.js";
import { MigrationSets } from "../../infrastructure/database/migrations/MigrationCatalog.js";
import { OWNER_PASSWORD, ProvisionedTenants } from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createContainer, disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";
import { log, runCommand } from "./runCommand.js";

/**
 * yarn load:seed [--vehicles 40] [--drivers 40] [--payments 300]
 *
 * A tenant for the authenticated load test (load/k6/tenant-api.js) on a LOCAL database: a console
 * admin, a provisioned tenant through the real approval flow, then vehicles, drivers, customers
 * and payments. Prints the TENANT, EMAIL and PASSWORD to run k6 with. Never against production:
 * it creates staff and tenants.
 */
runCommand("load:seed", async () => {
  const { values } = parseArgs({
    options: {
      vehicles: { type: "string", default: "40" },
      drivers: { type: "string", default: "40" },
      payments: { type: "string", default: "300" },
    },
  });
  // In-process requests come from one address: lift the per-IP limit for the seeding only.
  const config = loadConfig({
    ...process.env,
    RATE_LIMIT_MAX: "1000000",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
  });
  if (config.env === "production") {
    console.error("load:seed creates tenants and staff: never run it in production.");
    return 1;
  }
  const container = createContainer(
    config,
    await MigrationSets.load(config.database.migrationsDir),
  );
  try {
    const app = container.get<Express>(TYPES.HttpApp);
    const staff = await new StaffFixtures(container).create(["super_admin"]);
    const tenant = await new ProvisionedTenants(container, app, staff).create();
    log(`tenant ${tenant.slug} provisioned`);
    const auth = { Authorization: `Bearer ${tenant.ownerAccessToken}` };
    const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
    const post = async (path: string, body: object) => {
      const res = await request(app).post(path).set(auth).send(body);
      if (res.status >= 300) throw new Error(`${path}: ${JSON.stringify(res.body)}`);
      return res.body as { data: { id: string } };
    };

    for (let i = 0; i < Number(values.vehicles); i += 1)
      await post("/api/v1/vehicles", {
        make: i % 2 === 0 ? "Toyota" : "Hyundai",
        model: i % 2 === 0 ? "Vitz" : "Elantra",
        plateNumber: `GR ${digits(4)}-${String(20 + (i % 6))}`,
        odometer: 10_000 + i * 1_000,
      });
    log(`${values.vehicles} vehicles`);
    for (let i = 0; i < Number(values.drivers); i += 1)
      await post("/api/v1/drivers", {
        firstName: "Load",
        lastName: `Driver${i}`,
        phone: `+23324${digits(7)}`,
        ghanaCardNumber: `GHA-${digits(9)}-1`,
        licenceNumber: `DL-${randomUUID().slice(0, 6)}`,
        licenceClass: "B",
        licenceExpiresOn: "2030-01-01",
      });
    log(`${values.drivers} drivers`);
    const customers: string[] = [];
    for (let i = 0; i < 20; i += 1)
      customers.push(
        (
          await post("/api/v1/customers", {
            type: "individual",
            firstName: "Load",
            lastName: `Customer${i}`,
            phone: `024${digits(7)}`,
          })
        ).data.id,
      );
    for (let i = 0; i < Number(values.payments); i += 1)
      await post("/api/v1/payments", {
        direction: "in",
        partyType: "customer",
        partyId: customers[i % customers.length],
        amount: `${50 + (i % 20) * 10}.00`,
        method: "momo",
        momoNetwork: "mtn",
        reference: `LOAD-${digits(8)}`,
      });
    log(`${values.payments} payments`);

    console.info(`
Run the authenticated load test with:
  TENANT=${tenant.slug} EMAIL=${tenant.ownerEmail} PASSWORD='${OWNER_PASSWORD}' PROFILE=load yarn load:tenant`);
    return 0;
  } finally {
    await disposeContainer(container);
  }
});
