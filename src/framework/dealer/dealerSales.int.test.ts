import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DealerCrmAlerts } from "../../application/use-cases/dealer/DealerCrmAlerts.js";
import {
  OWNER_PASSWORD,
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * Dealer sales (P7-5) end to end: leads captured and handed out in turn, sales executives seeing
 * only their own, the pipeline with a lost reason, activities and follow-ups, the funnel; a test
 * drive booked against a block, a clash refused, the waiver issued when it goes out and the lead
 * moved on; a quote below the minimum approved, sent as a document, accepted, and another
 * lapsing; follow-up reminders and saved-search matches from the daily job.
 */
let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;
let ama: Session;
let kofi: Session;
let branchId: string;

type Session = { token: string; userId: string };

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const owner = () => as(t.ownerAccessToken);
const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const at = (offset: number, hour: number) => {
  const d = new Date(Date.now() + offset * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const digits = (n: number) =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");
const post = (path: string, body: Record<string, unknown> = {}, headers = owner()) =>
  api().post(path).set(headers).send(body);
const phone = () => `+23324${digits(7)}`;

async function join(roleId: string, name: string): Promise<Session> {
  const email = `user-${randomUUID().slice(0, 8)}@example.com`;
  const invited = await post("/api/v1/users/invitations", {
    name,
    email,
    branchIds: [branchId],
    roles: [{ roleId, branchId: null }],
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(201);
  const { rows } = await platform.query<{ body_text: string }>(
    `select body_text from email_deliveries where recipient = $1
      and template = 'tenant.user_invitation' order by created_at desc limit 1`,
    [email],
  );
  const token = /#token=([A-Za-z0-9_-]+)/.exec(rows[0]!.body_text)![1]!;
  const accepted = await api()
    .post("/api/v1/auth/invitations/accept")
    .set("X-Tenant", t.slug)
    .send({ token, password: OWNER_PASSWORD });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const me = await api()
    .get("/api/v1/me")
    .set(as(accepted.body.data.accessToken as string));
  return {
    token: accepted.body.data.accessToken as string,
    userId: me.body.data.userId as string,
  };
}

/** A stock vehicle, ready, priced and listed. */
async function listed(body: Record<string, unknown>, price = "60000.00", minimum = "55000.00") {
  const v = await post("/api/v1/vehicles", {
    make: "Toyota",
    model: "Corolla",
    year: 2019,
    plateNumber: `GR ${digits(4)}-26`,
    ...body,
  });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  const id = v.body.data.id as string;
  await post("/api/v1/dealer/stock", { vehicleId: id, source: "trade_in" }).expect(201);
  const priced = await api()
    .patch(`/api/v1/dealer/stock/${id}/pricing`)
    .set(owner())
    .send({ askingPrice: price, minimumPrice: minimum });
  expect(priced.status, JSON.stringify(priced.body)).toBe(200);
  await post(`/api/v1/dealer/stock/${id}/list`).expect(200);
  return id;
}

async function inbox(token: string): Promise<{ title: string }[]> {
  const res = await api().get("/api/v1/notifications?limit=100").set(as(token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { title: string }[];
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  const branches = await api().get("/api/v1/branches").set(owner());
  branchId = (branches.body.data as { id: string }[])[0]!.id;
  // The Sales Executive template: own leads, branch-wide test drives and quotes.
  const roles = await api().get("/api/v1/roles").set(owner());
  const role = (roles.body.data as { id: string; name: string }[]).find(
    (r) => r.name === "Sales Executive",
  )!;
  ama = await join(role.id, "Ama Sales");
  kofi = await join(role.id, "Kofi Sales");
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("dealer sales", () => {
  it("hands leads out in turn, keeps sales executives to their own and runs the pipeline", async () => {
    const rotation = await api()
      .put(`/api/v1/dealer/lead-rotation/${branchId}`)
      .set(owner())
      .send({ userIds: [ama.userId, kofi.userId] });
    expect(rotation.status, JSON.stringify(rotation.body)).toBe(200);
    expect(rotation.body.data).toEqual([ama.userId, kofi.userId]);

    const capture = (name: string) =>
      post("/api/v1/dealer/leads", { source: "walk_in", name, phone: phone(), branchId });
    const first = await capture("Yaw Boateng");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data).toMatchObject({ stage: "new", assignedTo: ama.userId });
    expect(first.body.data.number).toMatch(/^LD-/);
    const second = await capture("Esi Owusu");
    expect(second.body.data.assignedTo).toBe(kofi.userId);
    const third = await capture("Kwesi Appiah");
    expect(third.body.data.assignedTo).toBe(ama.userId);
    expect((await inbox(ama.token)).filter((n) => /lead/i.test(n.title)).length).toBeGreaterThan(0);

    // --- a sales executive sees only theirs; taking another's lead is refused ---
    const mine = await api().get("/api/v1/dealer/leads").set(as(kofi.token));
    expect((mine.body.data as { id: string }[]).map((l) => l.id)).toEqual([second.body.data.id]);
    const theirs = await api()
      .get(`/api/v1/dealer/leads/${first.body.data.id}`)
      .set(as(kofi.token));
    expect(theirs.status).toBe(404);
    const handOver = await post(
      "/api/v1/dealer/leads",
      { source: "phone", name: "Abena", phone: phone(), assignTo: ama.userId },
      as(kofi.token),
    );
    expect(handOver.status).toBe(422);
    const own = await post(
      "/api/v1/dealer/leads",
      { source: "phone", name: "Abena", phone: phone() },
      as(kofi.token),
    );
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(own.body.data.assignedTo).toBe(kofi.userId);

    // --- a call moves it to contacted; a follow-up; lost needs a reason ---
    const id = first.body.data.id as string;
    const called = await post(
      `/api/v1/dealer/leads/${id}/activities`,
      { kind: "call", note: "Wants a Corolla" },
      as(ama.token),
    );
    expect(called.status, JSON.stringify(called.body)).toBe(201);
    expect(called.body.data.stage).toBe("contacted");
    const task = await post(
      `/api/v1/dealer/leads/${id}/tasks`,
      { title: "Call back with prices", dueOn: day(0) },
      as(ama.token),
    );
    expect(task.status, JSON.stringify(task.body)).toBe(201);
    expect(task.body.data.tasks).toHaveLength(1);

    const alerts = container.get<DealerCrmAlerts>(TYPES.DealerCrmAlerts);
    await t.tenant.run(() => alerts.run(day(0)));
    await t.tenant.run(() => alerts.run(day(0)));
    expect(
      (await inbox(ama.token)).filter((n) => n.title.includes("Call back with prices")),
    ).toHaveLength(1);
    const done = await post(
      `/api/v1/dealer/leads/${id}/tasks/${task.body.data.tasks[0].id}/done`,
      {},
      as(ama.token),
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);

    const lost = await post(`/api/v1/dealer/leads/${third.body.data.id}/stage`, { stage: "lost" });
    expect(lost.status).toBe(422);
    const gone = await post(`/api/v1/dealer/leads/${third.body.data.id}/stage`, {
      stage: "lost",
      reason: "Bought elsewhere",
    });
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    expect(gone.body.data).toMatchObject({ stage: "lost", lostReason: "Bought elsewhere" });

    const detail = await api().get(`/api/v1/dealer/leads/${id}`).set(owner());
    expect((detail.body.data.activities as { kind: string }[]).map((a) => a.kind)).toEqual(
      expect.arrayContaining(["call", "stage"]),
    );

    const funnel = await api()
      .get(`/api/v1/dealer/leads/funnel?from=${day(-1)}&to=${day(1)}`)
      .set(owner());
    expect(funnel.status, JSON.stringify(funnel.body)).toBe(200);
    expect(funnel.body.data.total).toMatchObject({ leads: 4, lost: 1, won: 0 });
    expect(funnel.body.data.stages).toMatchObject({ lost: 1, contacted: 1 });
    const kofis = await api()
      .get(`/api/v1/dealer/leads/funnel?from=${day(-1)}&to=${day(1)}`)
      .set(as(kofi.token));
    expect(kofis.body.data.total.leads).toBe(2);
  });

  it("books a test drive on a block, issues the waiver and moves the lead on", async () => {
    const vehicleId = await listed({ model: "Yaris" });
    const lead = await post("/api/v1/dealer/leads", {
      source: "website",
      name: "Akosua Darko",
      phone: phone(),
      assignTo: ama.userId,
    });
    expect(lead.status, JSON.stringify(lead.body)).toBe(201);
    const leadId = lead.body.data.id as string;

    const booking = {
      vehicleId,
      leadId,
      startsAt: at(1, 10),
      endsAt: at(1, 11),
      licenceNumber: "gh-0012345",
      licenceExpiresOn: day(200),
    };
    const expired = await post(
      "/api/v1/dealer/test-drives",
      { ...booking, licenceExpiresOn: day(0) },
      as(ama.token),
    );
    expect(expired.status).toBe(422);
    const booked = await post("/api/v1/dealer/test-drives", booking, as(ama.token));
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(booked.body.data).toMatchObject({
      status: "booked",
      driverName: "Akosua Darko",
      licenceNumber: "GH-0012345",
      accompaniedBy: ama.userId,
    });
    const clash = await post(
      "/api/v1/dealer/test-drives",
      { ...booking, leadId: null, driverName: "Other", driverPhone: phone() },
      as(kofi.token),
    );
    expect(clash.status).toBe(409);
    const leadNow = await api().get(`/api/v1/dealer/leads/${leadId}`).set(owner());
    expect(leadNow.body.data.stage).toBe("appointment");

    const id = booked.body.data.id as string;
    const out = await post(
      `/api/v1/dealer/test-drives/${id}/start`,
      { odometer: 42_000 },
      as(ama.token),
    );
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.data.status).toBe("out");
    expect(out.body.data.waiverDocumentId).toEqual(expect.any(String));
    const waiver = await api()
      .get(`/api/v1/documents/${out.body.data.waiverDocumentId}`)
      .set(owner());
    expect(waiver.status, JSON.stringify(waiver.body)).toBe(200);
    expect(waiver.body.data.type).toBe("test_drive_waiver");

    const back = await post(
      `/api/v1/dealer/test-drives/${id}/return`,
      { odometer: 42_018, feedback: "Smooth" },
      as(ama.token),
    );
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.data).toMatchObject({ status: "returned", odometerIn: 42_018 });
    const after = await api().get(`/api/v1/dealer/leads/${leadId}`).set(owner());
    expect(after.body.data.stage).toBe("test_drive");

    // --- the slot is free again ---
    const again = await post(
      "/api/v1/dealer/test-drives",
      { ...booking, leadId: null, driverName: "Other", driverPhone: phone() },
      as(kofi.token),
    );
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    const cancelled = await post(
      `/api/v1/dealer/test-drives/${again.body.data.id}/cancel`,
      { status: "cancelled", reason: "Rescheduling" },
      as(kofi.token),
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
  });

  it("approves a price below the minimum, sends the quote, records acceptance and lapses others", async () => {
    const vehicleId = await listed({ model: "Camry", year: 2020 }, "80000.00", "75000.00");
    const lead = await post("/api/v1/dealer/leads", {
      source: "referral",
      name: "Nana Asante",
      phone: phone(),
      assignTo: ama.userId,
    });
    const leadId = lead.body.data.id as string;

    const created = await post(
      "/api/v1/dealer/quotes",
      {
        vehicleId,
        leadId,
        discount: "6000.00",
        addOns: [{ kind: "tint", amount: "800.00" }],
        tradeIn: { description: "2012 Vitz", value: "20000.00" },
      },
      as(ama.token),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      status: "draft",
      customerName: "Nana Asante",
      belowMinimum: true,
      totals: {
        vehicle: { amountMinor: 74_000_00 },
        total: { amountMinor: 74_800_00 },
        balance: { amountMinor: 54_800_00 },
      },
    });
    expect(created.body.data.number).toMatch(/^QUO-/);
    const id = created.body.data.id as string;

    const early = await post(`/api/v1/dealer/quotes/${id}/send`, {}, as(ama.token));
    expect(early.status).toBe(422);
    const notHers = await post(`/api/v1/dealer/quotes/${id}/approve`, {}, as(ama.token));
    expect(notHers.status).toBe(422);
    await post(`/api/v1/dealer/quotes/${id}/approve`).expect(200);
    const sent = await post(`/api/v1/dealer/quotes/${id}/send`, {}, as(ama.token));
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.data).toMatchObject({ status: "sent", documentId: expect.any(String) });
    const doc = await api().get(`/api/v1/documents/${sent.body.data.documentId}`).set(owner());
    expect(doc.body.data.type).toBe("dealer_quote");
    const leadNow = await api().get(`/api/v1/dealer/leads/${leadId}`).set(owner());
    expect(leadNow.body.data.stage).toBe("negotiation");

    const accepted = await post(
      `/api/v1/dealer/quotes/${id}/decision`,
      { outcome: "accepted", note: "Deposit on Friday" },
      as(ama.token),
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.data.status).toBe("accepted");

    // --- another, at the asking price, lapses after its date ---
    const other = await post("/api/v1/dealer/quotes", {
      vehicleId,
      customerName: "Walk-in buyer",
      validUntil: day(3),
    });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    expect(other.body.data.belowMinimum).toBe(false);
    await post(`/api/v1/dealer/quotes/${other.body.data.id}/send`).expect(200);
    const alerts = container.get<DealerCrmAlerts>(TYPES.DealerCrmAlerts);
    await t.tenant.run(() => alerts.run(day(4)));
    const lapsed = await api().get(`/api/v1/dealer/quotes/${other.body.data.id}`).set(owner());
    expect(lapsed.body.data.status).toBe("expired");
  });

  it("tells the sales executive once when listed stock fits a saved search", async () => {
    const lead = await post("/api/v1/dealer/leads", {
      source: "whatsapp",
      name: "Efua Mensah",
      phone: phone(),
      assignTo: kofi.userId,
      make: "Honda",
      model: "Civic",
      yearFrom: 2017,
      budgetMax: "70000.00",
      notifyMatches: true,
    });
    expect(lead.status, JSON.stringify(lead.body)).toBe(201);
    await listed({ make: "Honda", model: "Civic", year: 2018 }, "65000.00", "60000.00");
    await listed({ make: "Honda", model: "Civic", year: 2016 }, "50000.00", "45000.00");

    const matches = await api()
      .get(`/api/v1/dealer/leads/${lead.body.data.id}/matches`)
      .set(as(kofi.token));
    expect(matches.status, JSON.stringify(matches.body)).toBe(200);
    expect(matches.body.data).toHaveLength(1);

    const alerts = container.get<DealerCrmAlerts>(TYPES.DealerCrmAlerts);
    await t.tenant.run(() => alerts.run(day(0)));
    await t.tenant.run(() => alerts.run(day(0)));
    expect(
      (await inbox(kofi.token)).filter((n) => n.title === "Honda Civic 2018 for Efua Mensah"),
    ).toHaveLength(1);
  });
});
