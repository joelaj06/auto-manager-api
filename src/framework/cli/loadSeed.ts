import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
 * yarn load:seed [--tenants 1] [--vehicles 40] [--drivers 40] [--payments 300]
 *
 * Tenants for the authenticated load tests on a LOCAL database: a console admin, tenants
 * provisioned through the real approval flow, then vehicles, drivers, customers and payments in
 * each. One tenant: prints the TENANT, EMAIL and PASSWORD for load/k6/tenant-api.js. Several:
 * writes their sign-ins to load/k6/data/tenants.json for load/k6/multi-tenant.js (git-ignored).
 * Never against production: it creates staff and tenants.
 */
const LOAD_DATA_DIR = fileURLToPath(new URL("../../../load/k6/data", import.meta.url));

type SeedSizes = Readonly<{ vehicles: string; drivers: string; payments: string }>;

/** Vehicles, drivers, customers and payments in one tenant, through the API. */
async function fill(app: Express, token: string, sizes: SeedSizes): Promise<void> {
  const auth = { Authorization: `Bearer ${token}` };
  const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
  const post = async (path: string, body: object) => {
    const res = await request(app).post(path).set(auth).send(body);
    if (res.status >= 300) throw new Error(`${path}: ${JSON.stringify(res.body)}`);
    return res.body as { data: { id: string } };
  };
  for (let i = 0; i < Number(sizes.vehicles); i += 1)
    await post("/api/v1/vehicles", {
      make: i % 2 === 0 ? "Toyota" : "Hyundai",
      model: i % 2 === 0 ? "Vitz" : "Elantra",
      plateNumber: `GR ${digits(4)}-${String(20 + (i % 6))}`,
      odometer: 10_000 + i * 1_000,
    });
  for (let i = 0; i < Number(sizes.drivers); i += 1)
    await post("/api/v1/drivers", {
      firstName: "Load",
      lastName: `Driver${i}`,
      phone: `+23324${digits(7)}`,
      ghanaCardNumber: `GHA-${digits(9)}-1`,
      licenceNumber: `DL-${randomUUID().slice(0, 6)}`,
      licenceClass: "B",
      licenceExpiresOn: "2030-01-01",
    });
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
  for (let i = 0; i < Number(sizes.payments); i += 1)
    await post("/api/v1/payments", {
      direction: "in",
      partyType: "customer",
      partyId: customers[i % customers.length],
      amount: `${50 + (i % 20) * 10}.00`,
      method: "momo",
      momoNetwork: "mtn",
      reference: `LOAD-${digits(8)}`,
    });
}

runCommand("load:seed", async () => {
  const { values } = parseArgs({
    options: {
      tenants: { type: "string", default: "1" },
      vehicles: { type: "string", default: "40" },
      drivers: { type: "string", default: "40" },
      payments: { type: "string", default: "300" },
    },
  });
  // In-process requests come from one address: lift the per-IP limit for the seeding only.
  const config = loadConfig({
    ...process.env,
    RATE_LIMIT_MAX: "1000000",
    AUTH_RATE_LIMIT_MAX: "1000000",
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
    const tenants = new ProvisionedTenants(container, app, staff);
    const count = Number(values.tenants);
    const seeded: { tenant: string; email: string; password: string }[] = [];
    for (let n = 0; n < count; n += 1) {
      const tenant = await tenants.create();
      await fill(app, tenant.ownerAccessToken, values);
      seeded.push({ tenant: tenant.slug, email: tenant.ownerEmail, password: OWNER_PASSWORD });
      log(`tenant ${n + 1}/${count} ${tenant.slug} provisioned and filled`);
    }
    if (count === 1) {
      const only = seeded[0]!;
      console.info(`
Run the authenticated load test with:
  TENANT=${only.tenant} EMAIL=${only.email} PASSWORD='${OWNER_PASSWORD}' PROFILE=load yarn load:tenant`);
    } else {
      const file = join(LOAD_DATA_DIR, "tenants.json");
      await mkdir(LOAD_DATA_DIR, { recursive: true });
      await writeFile(file, JSON.stringify(seeded, null, 2));
      console.info(`
${count} tenants written to ${file}. Run the multi-tenant load test with:
  PROFILE=load yarn load:tenants`);
    }
    return 0;
  } finally {
    await disposeContainer(container);
  }
});
