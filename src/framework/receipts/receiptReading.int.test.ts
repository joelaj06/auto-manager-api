import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IJobHandler } from "../../application/jobs/IJobHandler.js";
import type { ITenantDailyTask } from "../../application/jobs/ITenantDailyTask.js";
import {
  ReceiptReaderError,
  type IReceiptReader,
  type ReceiptRead,
} from "../../application/ports/IReceiptReader.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const READ: ReceiptRead = {
  merchant: "Star Oil",
  date: "2026-10-30",
  total: "300.00",
  tax: "15.00",
  currency: "GHS",
  isReceipt: true,
  confidence: "high",
  model: "fake",
  inputTokens: 10,
  outputTokens: 5,
};

class FakeReader implements IReceiptReader {
  readonly configured = true;
  calls = 0;
  failure: ReceiptReaderError | null = null;

  read(): Promise<ReceiptRead> {
    this.calls += 1;
    return this.failure === null ? Promise.resolve(READ) : Promise.reject(this.failure);
  }
}

let container: Container;
let app: Express;
let t: ProvisionedTenant;
let categoryId: string;
const reader = new FakeReader();

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });

const runJob = (readingId: string, attempt = 1) =>
  t.tenant.run(() =>
    container
      .get<IJobHandler[]>(TYPES.ReceiptJobHandlers)
      .find((h) => h.job === "tenant.receipt_read")!
      .handle({ tenantId: t.tenantId, readingId }, { jobId: "test", attempt }),
  );

async function upload(started: { upload: { method: string; url: string; headers: object } }) {
  const { url, headers } = started.upload;
  const put = await fetch(url, {
    method: "PUT",
    headers: headers as Record<string, string>,
    body: PNG,
  });
  expect(put.ok).toBe(true);
}

const file = { filename: "receipt.png", contentType: "image/png", sizeBytes: PNG.length };

async function scan(): Promise<string> {
  const started = await api().post("/api/v1/receipt-readings").set(owner()).send(file);
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  await upload(started.body.data);
  const done = await api()
    .post(`/api/v1/receipt-readings/${started.body.data.readingId}/complete`)
    .set(owner());
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect(done.body.data.status).toBe("queued");
  return started.body.data.readingId as string;
}

const newExpense = async (amount: string) =>
  (
    await api().post("/api/v1/expenses").set(owner()).send({
      categoryId,
      description: "Fuel",
      payeeName: "Star Oil",
      amount,
      expenseDate: "2026-10-30",
    })
  ).body.data.expense.id as string;

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  container.rebind<IReceiptReader>(TYPES.ReceiptReader).toConstantValue(reader);
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  const categories = (await api().get("/api/v1/expense-categories").set(owner())).body.data as {
    id: string;
    code: string;
  }[];
  categoryId = categories.find((c) => c.code === "other")!.id;
}, 120_000);

afterAll(async () => {
  await disposeContainer(container);
});

describe("reading receipts", () => {
  it("is off until the business switches it on", async () => {
    const settings = await api().get("/api/v1/settings/receipt-reading").set(owner());
    expect(settings.body.data).toMatchObject({ available: true, enabled: false, usedThisMonth: 0 });
    const refused = await api().post("/api/v1/receipt-readings").set(owner()).send(file);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("RECEIPT_READING_OFF");
    const expense = await newExpense("10.00");
    const started = await api()
      .post(`/api/v1/expenses/${expense}/receipts`)
      .set(owner())
      .send(file);
    await upload(started.body.data);
    const done = await api()
      .post(`/api/v1/expenses/${expense}/receipts/${started.body.data.file.id}/complete`)
      .set(owner());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(reader.calls).toBe(0);
  });

  it("reads a scan, for the person who made it", async () => {
    await api().put("/api/v1/settings/receipt-reading").set(owner()).send({ enabled: true });
    const id = await scan();
    await runJob(id);
    const read = await api().get(`/api/v1/receipt-readings/${id}`).set(owner());
    expect(read.body.data).toMatchObject({
      status: "done",
      merchant: "Star Oil",
      date: "2026-10-30",
      total: "300.0000",
      tax: "15.0000",
      confidence: "high",
    });
  });

  it("reads once, whatever runs the job again", async () => {
    const id = await scan();
    const before = reader.calls;
    await runJob(id);
    await runJob(id);
    expect(reader.calls).toBe(before + 1);
  });

  it("attaches the scan to its expense and says where they disagree", async () => {
    const id = await scan();
    await runJob(id);
    const expense = await newExpense("350.00");
    const attached = await api()
      .post(`/api/v1/receipt-readings/${id}/attach`)
      .set(owner())
      .send({ expenseId: expense });
    expect(attached.status, JSON.stringify(attached.body)).toBe(200);
    expect(attached.body.data.warnings).toEqual([expect.stringContaining("The receipt says 300")]);
    const full = await api().get(`/api/v1/expenses/${expense}`).set(owner());
    expect((full.body.data.receipts as { id: string }[]).map((r) => r.id)).toEqual([
      attached.body.data.fileId,
    ]);
    expect((await api().get(`/api/v1/receipt-readings/${id}`).set(owner())).status).toBe(404);
    expect((await api().get(`/api/v1/expenses/${expense}`).set(owner())).body.data.amount).toEqual(
      full.body.data.amount,
    );
  });

  it("reads a receipt as it is attached", async () => {
    const expense = await newExpense("300.00");
    const started = await api()
      .post(`/api/v1/expenses/${expense}/receipts`)
      .set(owner())
      .send(file);
    await upload(started.body.data);
    const fileId = started.body.data.file.id as string;
    await api().post(`/api/v1/expenses/${expense}/receipts/${fileId}/complete`).set(owner());
    const path = `/api/v1/expenses/${expense}/receipts/${fileId}/reading`;
    const queued = await api().get(path).set(owner());
    expect(queued.body.data.status).toBe("queued");
    await runJob(queued.body.data.id as string);
    const read = await api().get(path).set(owner());
    expect(read.body.data).toMatchObject({ status: "done", warnings: [] });
  });

  it("records a failure instead of trying for ever", async () => {
    const id = await scan();
    reader.failure = new ReceiptReaderError("Provider is down", false);
    await expect(runJob(id, 1)).rejects.toThrow("Provider is down");
    await runJob(id, 4);
    reader.failure = null;
    const read = await api().get(`/api/v1/receipt-readings/${id}`).set(owner());
    expect(read.body.data).toMatchObject({ status: "failed", error: "Provider is down" });
  });

  it("stops at the monthly limit", async () => {
    const used = (await api().get("/api/v1/settings/receipt-reading").set(owner())).body.data
      .usedThisMonth as number;
    await api().put("/api/v1/settings/receipt-reading").set(owner()).send({ monthlyLimit: used });
    const refused = await api().post("/api/v1/receipt-readings").set(owner()).send(file);
    expect(refused.body.error.code).toBe("RECEIPT_READING_LIMIT");
    await api().put("/api/v1/settings/receipt-reading").set(owner()).send({ monthlyLimit: 500 });
  });

  it("clears away scans nobody attached", async () => {
    const id = await scan();
    await t.tenant.query(
      "update receipt_readings set created_at = now() - interval '8 days' where id = $1",
      [id],
    );
    const task = container
      .get<ITenantDailyTask[]>(TYPES.TenantDailyTasks)
      .find((d) => d.name === "receipt_scans")!;
    await t.tenant.run(() => task.run("2026-11-03"));
    expect((await api().get(`/api/v1/receipt-readings/${id}`).set(owner())).status).toBe(404);
  });
});
