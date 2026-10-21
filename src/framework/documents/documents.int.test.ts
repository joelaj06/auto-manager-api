import { createHash, randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IJobHandler } from "../../application/jobs/IJobHandler.js";
import { DOCUMENT_TYPE_CATALOG } from "../../domain/documents/DocumentTypes.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

let container: Container;
let app: Express;
let t: ProvisionedTenant;
let assignment: string;

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const system = DOCUMENT_TYPE_CATALOG.vehicle_handover.system.body;
const binary = (req: request.Test) =>
  req.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => done(null, Buffer.concat(chunks)));
  });

/** Downloads a document's PDF the way a client does: the link, then the bytes. */
async function pdfOf(id: string): Promise<{ bytes: Buffer; sha256: string }> {
  const res = await api().get(`/api/v1/documents/${id}/download`).set(owner());
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const bytes = Buffer.from(await (await fetch(res.body.data.url as string)).arrayBuffer());
  return { bytes, sha256: res.body.data.sha256 as string };
}

const handover = async (replacesId?: string) => {
  const res = await api()
    .post(`/api/v1/assignments/${assignment}/handover-document`)
    .set(owner())
    .send(replacesId === undefined ? {} : { replacesId });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; number: string; code: string; templateVersion: string };
};

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();

  const driver = (
    await api()
      .post("/api/v1/drivers")
      .set(owner())
      .send({
        firstName: "Abena",
        lastName: "Owusu",
        phone: `024${digits(7)}`,
        ghanaCardNumber: `GHA-${digits(9)}-1`,
        licenceNumber: `DL-${randomUUID().slice(0, 6)}`,
        licenceClass: "B",
        licenceExpiresOn: "2030-01-01",
      })
  ).body.data.id as string;
  await api()
    .post(`/api/v1/drivers/${driver}/guarantors`)
    .set(owner())
    .send({ name: "Yaw", phone: `020${digits(7)}` });
  await api().post(`/api/v1/drivers/${driver}/activate`).set(owner()).send({});
  const vehicle = (
    await api()
      .post("/api/v1/vehicles")
      .set(owner())
      .send({ make: "Kia", model: "Picanto", plateNumber: `GR ${digits(4)}-26`, odometer: 30_000 })
  ).body.data.id as string;
  const settings = await api().get("/api/v1/settings/assignments").set(owner());
  const assigned = await api()
    .post(`/api/v1/vehicles/${vehicle}/assignment`)
    .set(owner())
    .send({
      driverId: driver,
      odometer: 30_000,
      checklist: {
        items: (settings.body.data.handoverItems as { key: string }[]).map((i, n) => ({
          key: i.key,
          ok: n !== 0,
          ...(n === 0 ? { note: "Missing" } : {}),
        })),
      },
      terms: { mode: "fixed_target", target: "180.00", frequency: "daily", daysOff: [0] },
    });
  expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
  assignment = assigned.body.data.assignment.id as string;
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("templates", () => {
  it("lists the types with their locked clauses and previews the system template", async () => {
    const types = await api().get("/api/v1/document-types").set(owner());
    expect(types.status, JSON.stringify(types.body)).toBe(200);
    const transfer = (
      types.body.data as { type: string; system: { lockedClauses: { id: string }[] } }[]
    ).find((d) => d.type === "transfer_letter")!;
    expect(transfer.system.lockedClauses.map((c) => c.id)).toEqual([
      "transfer_of_ownership",
      "no_further_amount",
      "dvla_responsibility",
    ]);
    const preview = await binary(
      api()
        .post("/api/v1/document-templates/preview")
        .set(owner())
        .send({ type: "transfer_letter" }),
    );
    expect(preview.status).toBe(200);
    expect((preview.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("refuses drafts that change a locked clause or use an unknown field", async () => {
    const changed = await api()
      .post("/api/v1/document-templates")
      .set(owner())
      .send({
        type: "vehicle_handover",
        name: "Ours",
        body: system.replace("obey road traffic law", "drive"),
      });
    expect([changed.status, changed.body.error.code]).toEqual([422, "DOCUMENT_TEMPLATE"]);
    expect(changed.body.error.message).toMatch(
      /locked clause "Driver's responsibility" cannot be changed/,
    );
    const unknown = await api()
      .post("/api/v1/document-templates")
      .set(owner())
      .send({ type: "vehicle_handover", name: "Ours", body: `${system}<p>{{driver.salary}}</p>` });
    expect(unknown.body.error.message).toMatch(/Unknown field "driver.salary" on line \d+/);
    const script = await api()
      .post("/api/v1/document-templates")
      .set(owner())
      .send({ type: "vehicle_handover", name: "Ours", body: `${system}<script>x</script>` });
    expect(script.body.error.message).toMatch(/<script> is not allowed/);
  });

  it("puts a business's own version in use; versions in use never change", async () => {
    const own = system.replace(
      "<h2>Condition checklist</h2>",
      "<h2>Condition checklist</h2><p>No smoking in the vehicle.</p>",
    );
    const draft = await api()
      .post("/api/v1/document-templates")
      .set(owner())
      .send({ type: "vehicle_handover", name: "Handover with house rules", body: own });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.data).toMatchObject({ version: 1, status: "draft" });
    const id = draft.body.data.id as string;
    await api().put(`/api/v1/document-templates/${id}`).set(owner()).send({ name: "House rules" });
    const active = await api().post(`/api/v1/document-templates/${id}/activate`).set(owner());
    expect(active.body.data).toMatchObject({ status: "active", name: "House rules" });
    const edit = await api()
      .put(`/api/v1/document-templates/${id}`)
      .set(owner())
      .send({ name: "x" });
    expect(edit.body.error.message).toMatch(/Only a draft/);
    const types = await api().get("/api/v1/document-types").set(owner());
    expect(
      (types.body.data as { type: string; active: { en?: number } }[]).find(
        (d) => d.type === "vehicle_handover",
      )!.active,
    ).toEqual({ en: 1 });
  });
});

describe("issued documents", () => {
  let first: { id: string; number: string; code: string; templateVersion: string };
  let sha: string;

  it("issues a handover from the assignment with the template in use", async () => {
    first = await handover();
    expect(first).toMatchObject({
      number: expect.stringMatching(/^HND-\d{4}-\d{6}$/),
      code: expect.stringMatching(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/),
      templateVersion: "1",
      status: "issued",
      pdfFileId: null,
    });
    const doc = await api().get(`/api/v1/documents/${first.id}`).set(owner());
    expect(doc.body.data.data).toMatchObject({
      terms: { target: { amountMinor: 18_000 }, frequency: "every day", daysOff: "Sunday" },
      handover: { odometer: 30_000, unit: "km" },
      document: { number: first.number },
    });
    expect(doc.body.data.data.checklist[0]).toMatchObject({ ok: false, note: "Missing" });
  });

  it("renders the PDF once in the background and keeps it", async () => {
    const render = container
      .get<IJobHandler[]>(TYPES.DocumentJobHandlers)
      .find((h) => h.job === "documents.render")!;
    await t.tenant.run(() =>
      render.handle({ tenantId: t.tenantId, documentId: first.id }, { jobId: "j", attempt: 1 }),
    );
    // A redelivered job changes nothing.
    await t.tenant.run(() =>
      render.handle({ tenantId: t.tenantId, documentId: first.id }, { jobId: "j", attempt: 2 }),
    );
    const { bytes, sha256 } = await pdfOf(first.id);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
    sha = sha256;
    expect((await pdfOf(first.id)).sha256).toBe(sha);

    const doc = await api().get(`/api/v1/documents/${first.id}`).set(owner());
    expect((doc.body.data.events as { type: string }[]).map((e) => e.type)).toEqual([
      "issued",
      "rendered",
      "downloaded",
      "downloaded",
    ]);
  });

  it("cannot be changed or have its PDF replaced, even in the database", async () => {
    await expect(
      t.tenant.query("update documents set data_snapshot = '{}' where id = $1", [first.id]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      t.tenant.query("update documents set pdf_sha256 = repeat('0', 64) where id = $1", [first.id]),
    ).rejects.toThrow(/cannot be replaced/);
    await expect(t.tenant.query("delete from documents where id = $1", [first.id])).rejects.toThrow(
      /cannot be deleted/,
    );
    await expect(
      t.tenant.query(
        "update files set status = 'deleted', deleted_at = now() where owner_type = 'document' and owner_id = $1",
        [first.id],
      ),
    ).rejects.toThrow(/cannot change/);
    await expect(
      t.tenant.query("delete from document_events where document_id = $1", [first.id]),
    ).rejects.toThrow(/append-only/);
  });

  it("can be checked publicly by its code, with a copy's hash", async () => {
    const check = (code: string, sha256?: string) =>
      api()
        .get(`/api/v1/public/documents/${code}${sha256 === undefined ? "" : `?sha256=${sha256}`}`)
        .set("X-Tenant", t.slug);
    const valid = await check(first.code.toLowerCase(), sha);
    expect(valid.status, JSON.stringify(valid.body)).toBe(200);
    expect(valid.body.data).toMatchObject({
      found: true,
      name: "Vehicle handover",
      number: first.number,
      parties: ["Abena Owusu"],
      status: "issued",
      hashMatches: true,
    });
    expect(JSON.stringify(valid.body.data)).not.toContain("Picanto");
    expect((await check(first.code, "0".repeat(64))).body.data.hashMatches).toBe(false);
    expect((await check("ZZZZ-ZZZZ-ZZZZ")).body.data).toEqual({ found: false });
  });

  it("keeps issued documents on their template when a new version is put in use", async () => {
    const next = await api()
      .post("/api/v1/document-templates")
      .set(owner())
      .send({ type: "vehicle_handover", name: "v2", body: system });
    await api().post(`/api/v1/document-templates/${next.body.data.id}/activate`).set(owner());
    const second = await handover();
    expect(second.templateVersion).toBe("2");
    expect((await pdfOf(first.id)).sha256).toBe(sha);

    // Back to the system template.
    await api()
      .post("/api/v1/document-types/vehicle_handover/use-system")
      .set(owner())
      .send({ language: "en" });
    expect((await handover()).templateVersion).toBe("system-1");
  });

  it("is corrected by a new document that voids the old one", async () => {
    const correction = await handover(first.id);
    const old = await api().get(`/api/v1/documents/${first.id}`).set(owner());
    expect(old.body.data).toMatchObject({
      status: "void",
      voidReason: `Replaced by ${correction.number}`,
    });
    const verified = await api()
      .get(`/api/v1/public/documents/${first.code}`)
      .set("X-Tenant", t.slug);
    expect(verified.body.data).toMatchObject({ status: "void" });

    const voided = await api()
      .post(`/api/v1/documents/${correction.id}/void`)
      .set(owner())
      .send({ reason: "Assignment cancelled" });
    expect(voided.body.data).toMatchObject({ status: "void", voidReason: "Assignment cancelled" });
    const list = await api()
      .get(`/api/v1/documents?subjectType=vehicle_assignment&subjectId=${assignment}&status=void`)
      .set(owner());
    expect((list.body.data as { id: string }[]).map((d) => d.id)).toEqual([
      correction.id,
      first.id,
    ]);
  });
});
