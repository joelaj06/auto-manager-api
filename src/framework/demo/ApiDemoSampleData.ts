import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import type { IAccessTokenService } from "../../application/ports/IAccessTokenService.js";
import type { BusinessType, IDemoSampleData } from "../../application/ports/IDemoTenants.js";

type Report = Record<string, unknown>;
type Api = Readonly<{
  get: (path: string) => Promise<unknown>;
  post: (path: string, body: object) => Promise<{ id: string } & Record<string, unknown>>;
  put: (path: string, body: object) => Promise<unknown>;
}>;

const DAY_MS = 86_400_000;
const MAKES: readonly [string, string][] = [
  ["Toyota", "Corolla"],
  ["Toyota", "Vitz"],
  ["Hyundai", "Elantra"],
  ["Kia", "Rio"],
  ["Toyota", "Hiace"],
  ["Nissan", "Almera"],
  ["Hyundai", "Accent"],
  ["Toyota", "Yaris"],
  ["Kia", "Picanto"],
  ["Honda", "Civic"],
];
const PEOPLE: readonly [string, string][] = [
  ["Kwame", "Mensah"],
  ["Ama", "Owusu"],
  ["Kofi", "Boateng"],
  ["Akosua", "Asante"],
  ["Yaw", "Darko"],
  ["Efua", "Quaye"],
  ["Kojo", "Appiah"],
  ["Abena", "Ofori"],
  ["Kwesi", "Tetteh"],
  ["Adwoa", "Nyarko"],
  ["Nana", "Agyeman"],
];

/** Digits from the demo's own id, so each demo gets its own plates and phones. */
function numbers(seed: string): () => string {
  let state = Number.parseInt(seed.replace(/-/g, "").slice(0, 8), 16) || 1;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return String(state % 10_000).padStart(4, "0");
  };
}

/**
 * Sample data for a demo tenant (decision 501), entered through the tenant API as its owner on a
 * private loopback listener, so every record goes through the same rules, numbering and ledger
 * postings as real work: vehicles, drivers with guarantors, remittance assignments, customers,
 * a rental class with bookings, an invoice part paid, expenses waiting for approval and a Work &
 * Pay agreement ready to sign — what the business type uses. Each section is recorded when done,
 * so a retry carries on where it stopped.
 */
export class ApiDemoSampleData implements IDemoSampleData {
  constructor(
    private readonly deps: Readonly<{
      app: () => Express;
      tokens: IAccessTokenService;
      /** The demo's sample-data user (in the demo's database), opened and closed around the run. */
      user: Readonly<{
        open(tenantId: string): Promise<Readonly<{ id: string; permissionVersion: number }>>;
        close(tenantId: string, userId: string): Promise<void>;
      }>;
      now: () => Date;
    }>,
  ) {}

  async seed(
    target: Readonly<{ tenantId: string; slug: string; businessType: BusinessType }>,
    done: Readonly<Report>,
    progress: (report: Readonly<Report>) => Promise<void>,
  ): Promise<Readonly<Report>> {
    const user = await this.deps.user.open(target.tenantId);
    const { token } = await this.deps.tokens.issue({
      audience: "tenant",
      tenantId: target.tenantId,
      userId: user.id,
      sessionId: randomUUID(),
      permissionVersion: user.permissionVersion,
    });
    const server = createServer(this.deps.app());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const api = client(server, token);
      return await this.sections(api, target, { ...done }, progress);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await this.deps.user.close(target.tenantId, user.id);
    }
  }

  private async sections(
    api: Api,
    target: Readonly<{ tenantId: string; businessType: BusinessType }>,
    report: Report,
    progress: (report: Readonly<Report>) => Promise<void>,
  ): Promise<Report> {
    const type = target.businessType;
    const fleet = type === "fleet" || type === "mixed";
    const rental = type === "rental" || type === "mixed";
    const next = numbers(target.tenantId);
    const now = this.deps.now();
    const section = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
      if (report[key] !== undefined) return report[key] as T;
      const result = await work();
      report[key] = result;
      await progress(report);
      return result;
    };
    const phone = (prefix: string) => `+233${prefix}${next()}${next().slice(0, 3)}`;

    const vehicles = await section("vehicles", async () => {
      const ids: string[] = [];
      for (const [i, [make, model]] of MAKES.entries())
        ids.push(
          (
            await api.post("/api/v1/vehicles", {
              make,
              model,
              year: 2016 + (i % 7),
              plateNumber: `GR ${next()}-${String(18 + (i % 7))}`,
              odometer: 25_000 + i * 7_500,
            })
          ).id,
        );
      return ids;
    });

    const drivers =
      type === "dealer"
        ? []
        : await section("drivers", async () => {
            const ids: string[] = [];
            for (const [i, [first, last]] of PEOPLE.slice(0, 6).entries()) {
              const created = await api.post("/api/v1/drivers", {
                firstName: first,
                lastName: last,
                phone: phone("24"),
                ghanaCardNumber: `GHA-${next()}${next()}${next().slice(0, 1)}-1`,
                licenceNumber: `DL-${next()}${i}`,
                licenceClass: "B",
                licenceExpiresOn: `${now.getUTCFullYear() + 2}-06-30`,
                employmentType: i === 5 ? "workpay" : "remittance",
              });
              await api.post(`/api/v1/drivers/${created.id}/guarantors`, {
                name: `${PEOPLE[(i + 6) % PEOPLE.length]![0]} ${last}`,
                phone: phone("20"),
                relationship: "Relative",
              });
              await api.post(`/api/v1/drivers/${created.id}/activate`, {});
              ids.push(created.id);
            }
            return ids;
          });

    if (fleet)
      await section("assignments", async () => {
        const handover = (await api.get("/api/v1/settings/assignments")) as {
          handoverItems: { key: string }[];
        };
        const checklist = { items: handover.handoverItems.map((i) => ({ key: i.key, ok: true })) };
        for (let i = 0; i < 4; i++)
          await api.post(`/api/v1/vehicles/${vehicles[i]}/assignment`, {
            driverId: drivers[i],
            odometer: 25_000 + i * 7_500,
            checklist,
            terms: { mode: "fixed_target", target: "150.00", frequency: "daily" },
            startedAt: new Date(now.getTime() - 2 * DAY_MS).toISOString(),
          });
        return 4;
      });

    const customers = await section("customers", async () => {
      const ids: string[] = [];
      for (const [first, last] of PEOPLE.slice(6))
        ids.push(
          (
            await api.post("/api/v1/customers", {
              type: "individual",
              firstName: first,
              lastName: last,
              phone: phone("54"),
              email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
              dateOfBirth: "1988-03-14",
              licenceNumber: `DL-C${next()}`,
              licenceClass: "B",
              licenceExpiresOn: `${now.getUTCFullYear() + 3}-01-31`,
            })
          ).id,
        );
      ids.push(
        (
          await api.post("/api/v1/customers", {
            type: "corporate",
            companyName: "Coastline Logistics Ltd",
            email: "accounts@coastline.example.com",
            creditLimit: "5000.00",
            paymentTermsDays: 30,
          })
        ).id,
      );
      return ids;
    });

    if (rental)
      await section("rentals", async () => {
        const cls = await api.post("/api/v1/vehicle-classes", {
          code: "SALOON",
          name: "Saloon",
          deposit: "500.00",
        });
        await api.post("/api/v1/rental-rate-plans", {
          code: "SALOON-STD",
          name: "Saloon standard",
          classId: cls.id,
          dailyRate: "350.00",
        });
        for (const vehicle of vehicles.slice(6))
          await api.put(`/api/v1/vehicles/${vehicle}/rental-class`, { classId: cls.id });
        const bookings: string[] = [];
        for (const [i, customer] of customers.slice(0, 2).entries()) {
          const pickup = now.getTime() + (1 + i * 2) * DAY_MS;
          bookings.push(
            (
              await api.post("/api/v1/rentals", {
                classId: cls.id,
                customerId: customer,
                pickupAt: new Date(pickup).toISOString(),
                returnAt: new Date(pickup + (3 + i) * DAY_MS).toISOString(),
                confirm: true,
              })
            ).id,
          );
        }
        return { classId: cls.id, bookings };
      });

    await section("invoices", async () => {
      const draft = await api.post("/api/v1/invoices", {
        partyType: "customer",
        partyId: customers[customers.length - 1],
        lines: [{ description: "Vehicle hire — staff shuttle", quantity: 5, unitPrice: "450.00" }],
      });
      await api.post(`/api/v1/invoices/${draft.id}/issue`, {});
      await api.post("/api/v1/payments", {
        direction: "in",
        partyType: "customer",
        partyId: customers[customers.length - 1],
        amount: "1000.00",
        method: "bank_transfer",
        reference: "DEMO-TRANSFER-1",
        allocations: [{ invoiceId: draft.id, amount: "1000.00" }],
      });
      return 1;
    });

    await section("expenses", async () => {
      const tree = (await api.get("/api/v1/expense-categories")) as { code: string; id: string }[];
      const category = (code: string) => (tree.find((c) => c.code === code) ?? tree[0])!.id;
      const made = [
        { code: "fuel", description: "Fuel top-up", payee: "Goil Spintex", amount: "420.00" },
        {
          code: "maintenance",
          description: "Brake pads",
          payee: "Abossey Okai Parts",
          amount: "680.00",
        },
      ];
      for (const [i, e] of made.entries()) {
        const created = await api.post("/api/v1/expenses", {
          categoryId: category(e.code),
          description: e.description,
          payeeName: e.payee,
          amount: e.amount,
          vehicleIds: [vehicles[i]],
        });
        const expense = created.expense as { id: string } | undefined;
        await api.post(`/api/v1/expenses/${expense?.id ?? created.id}/submit`, {});
      }
      return made.length;
    });

    if (fleet)
      await section("workpay", async () => {
        const firstDue = new Date(now.getTime() + 7 * DAY_MS).toISOString().slice(0, 10);
        const agreement = await api.post("/api/v1/workpay/agreements", {
          vehicleId: vehicles[4],
          driverId: drivers[5],
          terms: {
            vehicleValue: "60000.00",
            pricing: { kind: "total", total: "78000.00" },
            deposit: "12000.00",
            frequency: "weekly",
            periods: 104,
            firstDueOn: firstDue,
            roundTo: "1.00",
          },
          graceDays: 2,
          penalty: { kind: "flat", amount: "50.00" },
          insurance: "driver",
        });
        return agreement.id;
      });

    return report;
  }
}

function client(server: Server, token: string): Api {
  const { port } = server.address() as AddressInfo;
  const call = async (method: string, path: string, body?: object) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: unknown; error?: unknown };
    if (!res.ok)
      throw new Error(
        `Sample data: ${method} ${path} answered ${res.status} ${JSON.stringify(json.error ?? json)}`,
      );
    return json.data;
  };
  return {
    get: (path) => call("GET", path),
    post: async (path, body) => (await call("POST", path, body)) as { id: string } & Report,
    put: (path, body) => call("PUT", path, body),
  };
}
