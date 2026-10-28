import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * Incidents, insurance claims, traffic offences and fuel anomalies (P6-4) end to end: an
 * accident putting the vehicle in accident and back on closing, its repair counted in its cost
 * with the driver's share, a claim approved and settled to insurance recoveries, fines paid by the
 * business and charged to the driver, contested and waived, and fills that look wrong flagged
 * for review.
 */
let container: Container;
let app: Express;
let t: ProvisionedTenant;
let driverId: string;
let insurer: string;

type Money = { amountMinor: number };

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");

async function vehicle(odometer = 10_000): Promise<string> {
  const res = await api()
    .post("/api/v1/vehicles")
    .set(owner())
    .send({ make: "Toyota", model: "Corolla", plateNumber: `GR ${digits(4)}-26`, odometer });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

const status = async (id: string) =>
  (await api().get(`/api/v1/vehicles/${id}`).set(owner())).body.data.status as string;

async function balance(code: string): Promise<number> {
  const tb = await api().get("/api/v1/ledger/trial-balance").set(owner());
  expect(tb.body.data.balanced).toBe(true);
  return (
    (tb.body.data.accounts as { code: string; balance: Money }[]).find((a) => a.code === code)
      ?.balance.amountMinor ?? 0
  );
}

async function titles(): Promise<string[]> {
  const inbox = await api().get("/api/v1/notifications?limit=50").set(owner());
  return (inbox.body.data as { title: string }[]).map((n) => n.title);
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  const res = await api()
    .post("/api/v1/drivers")
    .set(owner())
    .send({
      firstName: "Kofi",
      lastName: `Driver${digits(3)}`,
      phone: `+23324${digits(7)}`,
      ghanaCardNumber: `GHA-${digits(9)}-1`,
      licenceNumber: `DL-${randomUUID().slice(0, 6)}`,
      licenceClass: "B",
      licenceExpiresOn: "2030-01-01",
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  driverId = res.body.data.id as string;
  const company = await api()
    .post("/api/v1/suppliers")
    .set(owner())
    .send({ name: "Star Assurance", type: "insurer" });
  expect(company.status, JSON.stringify(company.body)).toBe(201);
  insurer = company.body.data.id as string;
  await api()
    .post("/api/v1/expense-approval-rules")
    .set(owner())
    .send({ name: "Small spend", maxAmount: "5000.00", action: "auto_approve", priority: 10 })
    .expect(201);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("incidents", () => {
  it("takes a vehicle off the road for an accident, counts its repair and recovers it from the insurer", async () => {
    const car = await vehicle();
    const reported = await api()
      .post("/api/v1/incidents")
      .set(owner())
      .send({
        vehicleId: car,
        type: "accident",
        severity: "major",
        occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
        location: "Tema motorway",
        description: "Rear-ended at the toll booth",
        driverId,
        policeReportNo: "TMA/123/26",
        thirdParties: [{ name: "Ama Owusu", plateNumber: "GT 4411-22" }],
      });
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    const incident = reported.body.data;
    expect(incident).toMatchObject({
      status: "open",
      driverId,
      vehicleStatus: "accident",
      statusBefore: "available",
    });
    expect(incident.number).toMatch(/^INC-\d{4}-\d{6}$/);
    expect(await status(car)).toBe("accident");
    expect(
      (await titles()).filter((x) => x.includes(`accident reported (${incident.number})`)),
    ).toHaveLength(1);

    // --- the repair, the driver paying part, counted in the incident's cost ---
    const opened = await api()
      .post("/api/v1/work-orders")
      .set(owner())
      .send({
        vehicleId: car,
        type: "corrective",
        title: "Rear bumper",
        lines: [{ kind: "part", description: "Bumper", quantity: 1, unitCost: "800.00" }],
      });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const job = opened.body.data.id as string;
    const linked = await api()
      .post(`/api/v1/incidents/${incident.id}/links`)
      .set(owner())
      .send({ workOrderId: job });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    const other = await vehicle();
    const foreign = await api()
      .post("/api/v1/work-orders")
      .set(owner())
      .send({ vehicleId: other, type: "corrective", title: "Other car" });
    const wrong = await api()
      .post(`/api/v1/incidents/${incident.id}/links`)
      .set(owner())
      .send({ workOrderId: foreign.body.data.id });
    expect([wrong.status, wrong.body.error.message]).toEqual([
      422,
      "No work order of this vehicle has that id",
    ]);
    await api().post(`/api/v1/work-orders/${job}/start`).set(owner()).send({}).expect(200);
    const done = await api()
      .post(`/api/v1/work-orders/${job}/complete`)
      .set(owner())
      .send({ allocations: [{ payer: "driver", amount: "200.00", driverId }] });
    expect(done.status, JSON.stringify(done.body)).toBe(200);

    // --- a claim: one live claim per insurer, approved, then settled ---
    const claim = await api()
      .post(`/api/v1/incidents/${incident.id}/claims`)
      .set(owner())
      .send({ insurerId: insurer, policyNo: "POL-77", claimed: "800.00", excess: "100.00" });
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    expect(claim.body.data.costs).toMatchObject({
      business: { amountMinor: 60_000 },
      driver: { amountMinor: 20_000 },
      expected: { amountMinor: 70_000 },
      recovered: { amountMinor: 0 },
      net: { amountMinor: 60_000 },
    });
    const claimId = claim.body.data.claims[0].id as string;
    const again = await api()
      .post(`/api/v1/incidents/${incident.id}/claims`)
      .set(owner())
      .send({ insurerId: insurer, claimed: "100.00" });
    expect(again.body.error.message).toBe("There is already a live claim on that insurer");
    const approved = await api()
      .post(`/api/v1/insurance-claims/${claimId}/approve`)
      .set(owner())
      .send({ approved: "550.00", claimNo: "SA-9001" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.costs.expected.amountMinor).toBe(55_000);
    const settled = await api()
      .post(`/api/v1/insurance-claims/${claimId}/settle`)
      .set(owner())
      .send({ amount: "550.00", method: "bank_transfer", reference: "TRF-1" });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body.data.claims[0]).toMatchObject({
      status: "settled",
      settled: { amountMinor: 55_000 },
    });
    expect(settled.body.data.costs).toMatchObject({
      recovered: { amountMinor: 55_000 },
      expected: { amountMinor: 0 },
      net: { amountMinor: 5_000 },
    });
    expect(await balance("4910")).toBe(55_000);
    const listed = await api().get("/api/v1/insurance-claims?status=settled").set(owner());
    expect((listed.body.data as { id: string }[]).map((c) => c.id)).toEqual([claimId]);

    // --- closed: the vehicle goes back; reopened and changed ---
    const closed = await api()
      .post(`/api/v1/incidents/${incident.id}/close`)
      .set(owner())
      .send({ outcome: "Repaired, insurer paid" });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await status(car)).toBe("available");
    const locked = await api()
      .patch(`/api/v1/incidents/${incident.id}`)
      .set(owner())
      .send({ severity: "minor" });
    expect(locked.status).toBe(422);
    await api().post(`/api/v1/incidents/${incident.id}/reopen`).set(owner()).send({}).expect(200);
    const changed = await api()
      .patch(`/api/v1/incidents/${incident.id}`)
      .set(owner())
      .send({ severity: "minor" });
    expect(changed.body.data).toMatchObject({ severity: "minor", status: "open" });

    // --- a minor accident leaves the vehicle where it is ---
    const scratch = await api().post("/api/v1/incidents").set(owner()).send({
      vehicleId: other,
      type: "accident",
      occurredAt: new Date().toISOString(),
      description: "Scraped a pillar in the car park",
    });
    expect(scratch.body.data).toMatchObject({ severity: "minor", vehicleStatus: null });
    expect(await status(other)).toBe("available");
    const mine = await api().get(`/api/v1/incidents?driverId=${driverId}`).set(owner());
    expect((mine.body.data as { id: string }[]).map((i) => i.id)).toEqual([incident.id]);
    const missing = await api().get(`/api/v1/incidents/${randomUUID()}`).set(owner());
    expect(missing.status).toBe(404);
  });

  it("records fines paid by the business and charged to the driver, contested and waived", async () => {
    const car = await vehicle();
    const record = (noticeRef: string, fine: string) =>
      api()
        .post("/api/v1/traffic-offences")
        .set(owner())
        .send({
          vehicleId: car,
          type: "speeding",
          offenceAt: new Date(Date.now() - 86_400_000).toISOString(),
          authority: "MTTD Accra",
          noticeRef,
          fine,
          driverId,
        });
    const first = await record("N-100", "200.00");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data).toMatchObject({
      status: "unpaid",
      driverPays: true,
      fine: { amountMinor: 20_000 },
    });
    const dup = await record("N-100", "200.00");
    expect(dup.body.error.message).toBe("Notice N-100 of MTTD Accra is already recorded");

    const paid = await api()
      .post(`/api/v1/traffic-offences/${first.body.data.id}/pay`)
      .set(owner())
      .send({ by: "business", reference: "RCPT-5" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.data).toMatchObject({ status: "paid", paidBy: "business" });
    const rows = await t.tenant.query<{
      amount_minor: string;
      charge_to_driver: boolean;
      driver_id: string;
      payee_name: string;
      code: string;
    }>(
      `select e.amount_minor::text, e.charge_to_driver, e.driver_id, e.payee_name, c.code
         from expenses e join expense_categories c on c.id = e.category_id where e.id = $1`,
      [paid.body.data.expenseId],
    );
    expect(rows[0]).toMatchObject({
      amount_minor: "20000",
      charge_to_driver: true,
      driver_id: driverId,
      payee_name: "MTTD Accra",
      code: "fines",
    });

    const second = await record("N-101", "150.00");
    await api()
      .post(`/api/v1/traffic-offences/${second.body.data.id}/contest`)
      .set(owner())
      .send({})
      .expect(200);
    const outstanding = await api()
      .get(`/api/v1/traffic-offences?vehicleId=${car}&outstanding=true`)
      .set(owner());
    expect((outstanding.body.data as { status: string }[]).map((o) => o.status)).toEqual([
      "contested",
    ]);
    const waived = await api()
      .post(`/api/v1/traffic-offences/${second.body.data.id}/waive`)
      .set(owner())
      .send({ note: "Camera fault confirmed" });
    expect(waived.body.data).toMatchObject({ status: "waived" });
    const late = await api()
      .post(`/api/v1/traffic-offences/${second.body.data.id}/pay`)
      .set(owner())
      .send({ by: "driver" });
    expect(late.body.error.message).toBe("The fine is waived");
  });

  it("flags fills far below the vehicle's usual km per litre and fills with no km", async () => {
    const car = await vehicle(10_000);
    const fill = (odometer: number, litres: string) =>
      api()
        .post(`/api/v1/vehicles/${car}/fuel`)
        .set(owner())
        .send({ litres, amount: "400.00", odometer, fullTank: true });
    for (const km of [10_000, 10_400, 10_800, 11_200]) {
      const res = await fill(km, "40");
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const none = await api().get(`/api/v1/fuel-anomalies?vehicleId=${car}`).set(owner());
    expect(none.body.data).toEqual([]);
    await fill(11_400, "40").expect(201);
    await fill(11_400, "20").expect(201);
    const found = await api().get(`/api/v1/fuel-anomalies?vehicleId=${car}`).set(owner());
    const anomalies = found.body.data as {
      id: string;
      kind: string;
      kmPerLitre: number;
      baseline: number | null;
    }[];
    expect(anomalies.map((a) => a.kind).sort()).toEqual(["low_efficiency", "no_distance"]);
    expect(anomalies.find((a) => a.kind === "low_efficiency")).toMatchObject({
      kmPerLitre: 5,
      baseline: 10,
    });
    expect((await titles()).some((x) => x.endsWith("5 km/L, usually 10"))).toBe(true);
    const reviewed = await api()
      .post(`/api/v1/fuel-anomalies/${anomalies[0]!.id}/review`)
      .set(owner())
      .send({ status: "confirmed", note: "Driver admitted siphoning" });
    expect(reviewed.body.data).toMatchObject({ status: "confirmed" });
    const twice = await api()
      .post(`/api/v1/fuel-anomalies/${anomalies[0]!.id}/review`)
      .set(owner())
      .send({ status: "dismissed", note: "Again" });
    expect(twice.body.error.message).toBe("The anomaly is already confirmed");
    const open = await api().get("/api/v1/fuel-anomalies?status=open").set(owner());
    expect((open.body.data as unknown[]).length).toBe(1);
  });
});
