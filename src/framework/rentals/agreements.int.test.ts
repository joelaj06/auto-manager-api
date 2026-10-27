import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IJobHandler } from "../../application/jobs/IJobHandler.js";
import type { ISmsGateway } from "../../application/ports/INotifications.js";
import {
  OWNER_PASSWORD,
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { signaturePng } from "../../testing/fixtures/signaturePng.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * The rental agreement and the return note (P5-6) end to end: the agreement issued at check-out
 * with the terms, charges and checklist, signed by the renter through their SMS link and by the
 * agent; issued again after an extension (the old one voided); the return note at check-in with
 * the return charges, and closing warns while it is unsigned.
 */
class FakeSms implements ISmsGateway {
  readonly provider = "arkesel" as const;
  readonly sent: { to: string; text: string }[] = [];
  send(_account: Parameters<ISmsGateway["send"]>[0], to: string, text: string) {
    this.sent.push({ to, text });
    return Promise.resolve({ messageId: `s-${this.sent.length}` });
  }
}

let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;
const sms = new FakeSms();
let hq: string;
let agent: string;
let agentEmail: string;
let renter: string;
let renterPhone: string;
let suv: string;

type Signer = { id: string; role: string; name: string; status: string };
type RentalDocument = {
  id: string;
  type: string;
  number: string;
  status: string;
  replacesId: string | null;
  signers: Signer[];
};

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const owner = () => as(t.ownerAccessToken);
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const drawn = { type: "drawn", png: signaturePng() };

async function lastEmail(to: string, template: string): Promise<string> {
  const { rows } = await platform.query<{ body_text: string }>(
    `select body_text from email_deliveries where recipient = $1 and template = $2
      order by created_at desc limit 1`,
    [to, template],
  );
  return rows[0]!.body_text;
}

/** Sends the queued SMS (the worker's job) and returns what went to `phone`. */
async function smsTo(phone: string): Promise<string> {
  const send = container
    .get<IJobHandler[]>(TYPES.NotificationJobHandlers)
    .find((h) => h.job === "notifications.send")!;
  await t.tenant.run(() => send.handle({ tenantId: t.tenantId }, { jobId: "j", attempt: 1 }));
  const last = sms.sent.filter((m) => m.to === phone).at(-1);
  if (last === undefined) throw new Error(`no SMS to ${phone}`);
  return last.text;
}

const step = (id: string, path: string, body: Record<string, unknown> = {}) =>
  api().post(`/api/v1/rentals/${id}/${path}`).set(as(agent)).send(body);
const documents = (res: request.Response) => res.body.data.documents as RentalDocument[];

/** The renter signs through the link in their SMS. */
async function renterSigns(): Promise<void> {
  const token = /#token=([A-Za-z0-9_-]+)/.exec(await smsTo(renterPhone))![1]!;
  const guest = (path: string, body: Record<string, unknown> = {}) =>
    api()
      .post(`/api/v1/public/signing/${path}`)
      .set("X-Tenant", t.slug)
      .send({ token, ...body });
  const open = await guest("open");
  expect(open.status, JSON.stringify(open.body)).toBe(200);
  await guest("code").expect(200);
  const code = /(\d{6}) is your code/.exec(await smsTo(renterPhone))![1]!;
  const signed = await guest("sign", { code, signature: drawn, consent: true });
  expect(signed.status, JSON.stringify(signed.body)).toBe(200);
}

/** The agent signs for the business with the code emailed to them. */
async function agentSigns(signerId: string): Promise<string> {
  await api().post(`/api/v1/me/signatures/${signerId}/code`).set(as(agent)).expect(200);
  const code = /\b(\d{6})\b/.exec(await lastEmail(agentEmail, "auth.otp_code"))![1]!;
  const signed = await api()
    .post(`/api/v1/me/signatures/${signerId}/sign`)
    .set(as(agent))
    .send({ code, signature: drawn, consent: true });
  expect(signed.status, JSON.stringify(signed.body)).toBe(200);
  return signed.body.data.document.status as string;
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  container.rebind<ISmsGateway[]>(TYPES.SmsGateways).toConstantValue([sms]);
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  const branches = await api().get("/api/v1/branches").set(owner());
  hq = (branches.body.data as { id: string; isDefault: boolean }[]).find((b) => b.isDefault)!.id;
  await api()
    .put("/api/v1/settings/notifications/sms")
    .set(owner())
    .send({ provider: "arkesel", senderId: "AutoFleet", credentials: { apiKey: "k" } })
    .expect(200);
  await api().patch("/api/v1/settings/notifications").set(owner()).send({ quietHours: null });

  const roles = await api().get("/api/v1/roles").set(owner());
  const roleId = (roles.body.data as { id: string; systemKey: string | null }[]).find(
    (r) => r.systemKey === "rental_agent",
  )!.id;
  agentEmail = `agent-${randomUUID().slice(0, 8)}@example.com`;
  await api()
    .post("/api/v1/users/invitations")
    .set(owner())
    .send({
      name: "Rental Agent",
      email: agentEmail,
      branchIds: [hq],
      roles: [{ roleId, branchId: hq }],
    })
    .expect(201);
  const invite = /#token=([A-Za-z0-9_-]+)/.exec(
    await lastEmail(agentEmail, "tenant.user_invitation"),
  )![1]!;
  agent = (
    await api()
      .post("/api/v1/auth/invitations/accept")
      .set("X-Tenant", t.slug)
      .send({ token: invite, password: OWNER_PASSWORD })
  ).body.data.accessToken as string;

  suv = (
    await api().post("/api/v1/vehicle-classes").set(owner()).send({ code: "SUV", name: "SUV" })
  ).body.data.id as string;
  const car = await api()
    .post("/api/v1/vehicles")
    .set(owner())
    .send({
      make: "Toyota",
      model: "RAV4",
      year: 2022,
      colour: "White",
      plateNumber: `GR ${digits(4)}-27`,
    });
  await api()
    .put(`/api/v1/vehicles/${car.body.data.id}/rental-class`)
    .set(owner())
    .send({ classId: suv })
    .expect(200);
  await api()
    .post("/api/v1/rental-rate-plans")
    .set(owner())
    .send({
      code: "SUV-STD",
      name: "SUV standard",
      classId: suv,
      dailyRate: "300.00",
      includedKmPerDay: 100,
      extraKmRate: "2.00",
    })
    .expect(201);
  await api()
    .patch("/api/v1/settings/rentals")
    .set(owner())
    .send({
      inspectionItems: [{ key: "spare_tyre", label: "Spare tyre" }],
      inspectionPhotoViews: [],
    })
    .expect(200);
  renterPhone = `+23324${digits(7)}`;
  const customer = await api()
    .post("/api/v1/customers")
    .set(owner())
    .send({
      type: "individual",
      firstName: "Abena",
      lastName: "Owusu",
      phone: renterPhone,
      email: `abena-${randomUUID().slice(0, 8)}@example.com`,
      dateOfBirth: "1990-04-01",
      ghanaCardNumber: `GHA-${digits(9)}-0`,
      licenceNumber: "DL-445566",
      licenceClass: "B",
      licenceExpiresOn: "2030-01-01",
    });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  renter = customer.body.data.id as string;
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("rental agreement and return note", () => {
  it("issues the agreement at check-out, signs it, reissues it and issues the return note", async () => {
    const now = Date.now();
    const booked = await api()
      .post("/api/v1/rentals")
      .set(as(agent))
      .send({
        classId: suv,
        customerId: renter,
        pickupAt: iso(now + HOUR),
        returnAt: iso(now + 25 * HOUR),
        confirm: true,
      });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const id = booked.body.data.id as string;
    expect(booked.body.data.documents).toEqual([]);
    refusedWith(await step(id, "agreement"), "once the vehicle is checked out");

    // --- check-out: the agreement, for the agent and the renter to sign ---
    const out = await step(id, "checkout", {
      odometer: 12_000,
      fuel: "full",
      idChecked: true,
      checklist: [{ key: "spare_tyre", ok: false, note: "Flat" }],
    });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const [agreement] = documents(out);
    expect(agreement).toMatchObject({
      type: "rental_agreement",
      number: expect.stringMatching(/^RAG-\d{4}-\d{6}$/),
      status: "pending_signatures",
      signers: [
        { role: "business", status: "pending" },
        { role: "renter", name: expect.stringContaining("Abena"), status: "pending" },
      ],
    });

    const doc = await api().get(`/api/v1/documents/${agreement!.id}`).set(as(agent));
    expect(doc.status, JSON.stringify(doc.body)).toBe(200);
    expect(doc.body.data.data).toMatchObject({
      renter: { name: expect.stringContaining("Abena"), phone: renterPhone },
      driver: { licenceNumber: "DL-445566" },
      vehicle: { make: "Toyota", model: "RAV4", year: 2022 },
      rental: {
        number: booked.body.data.number,
        odometer: 12_000,
        fuel: "full",
        plan: "SUV standard",
        mileage: expect.stringMatching(/^100 km a day included, then .*2\.00 a km$/),
        total: { amountMinor: 30_000 },
      },
      charges: [{ description: expect.any(String), amount: { amountMinor: 30_000 } }],
      checklist: [{ label: "Spare tyre", ok: false, note: "Flat" }],
      damages: [],
    });
    const pdf = await api().get(`/api/v1/documents/${agreement!.id}/download`).set(as(agent));
    expect(pdf.status, JSON.stringify(pdf.body)).toBe(200);

    // --- the renter signs through their link, then the agent ---
    await renterSigns();
    expect(await agentSigns(agreement!.signers[0]!.id)).toBe("fully_signed");
    const signed = await api().get(`/api/v1/rentals/${id}`).set(as(agent));
    expect(documents(signed)[0]).toMatchObject({ id: agreement!.id, status: "fully_signed" });
    expect((signed.body.data.events as { type: string }[]).map((e) => e.type)).toEqual(
      expect.arrayContaining(["agreement_issued", "agreement_signed"]),
    );

    // --- an extension: a new agreement replaces the signed one ---
    const extended = await step(id, "extend", { returnAt: iso(now + 49 * HOUR) });
    expect(extended.status, JSON.stringify(extended.body)).toBe(200);
    const reissued = await step(id, "agreement");
    expect(reissued.status, JSON.stringify(reissued.body)).toBe(200);
    expect(reissued.body.data).toMatchObject({
      type: "rental_agreement",
      status: "pending_signatures",
      replacesId: agreement!.id,
    });
    const listed = documents(await api().get(`/api/v1/rentals/${id}`).set(as(agent)));
    expect(listed.map((d) => [d.number, d.status])).toEqual([
      [reissued.body.data.number, "pending_signatures"],
      [agreement!.number, "void"],
    ]);
    const second = await api().get(`/api/v1/documents/${reissued.body.data.id}`).set(as(agent));
    expect(second.body.data.data.rental.total.amountMinor).toBe(60_000);

    // --- check-in: the return note with the return charges ---
    refusedWith(await step(id, "return-note"), "once the vehicle is back");
    const back = await step(id, "checkin", {
      odometer: 12_260,
      fuel: "full",
      checklist: [{ key: "spare_tyre", ok: true }],
    });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const note = documents(back).find((d) => d.type === "rental_return")!;
    expect(note).toMatchObject({
      number: expect.stringMatching(/^RRN-\d{4}-\d{6}$/),
      status: "pending_signatures",
    });
    const returned = await api().get(`/api/v1/documents/${note.id}`).set(as(agent));
    expect(returned.body.data.data).toMatchObject({
      rental: {
        agreementNumber: reissued.body.data.number,
        odometerOut: 12_000,
        odometerIn: 12_260,
        km: 260,
        fuelIn: "full",
      },
      checklist: [{ label: "Spare tyre", ok: true }],
      // Two days include 200 km: 60 km over at ₵2.
      charges: [{ amount: { amountMinor: 12_000 } }],
      damages: [],
    });

    // Closing warns about what is not signed yet.
    const closed = await step(id, "close");
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data.warnings).toEqual([
      `The return note ${note.number} is not signed by everyone yet`,
      `The rental agreement ${reissued.body.data.number} is not signed by everyone yet`,
    ]);
  });
});

function refusedWith(res: request.Response, message: string) {
  expect([res.status, res.body.error?.message]).toEqual([422, expect.stringContaining(message)]);
}
