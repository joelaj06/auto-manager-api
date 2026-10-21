import { createHash, randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IJobHandler } from "../../application/jobs/IJobHandler.js";
import type { ISmsGateway } from "../../application/ports/INotifications.js";
import type { Documents } from "../../application/use-cases/documents/Documents.js";
import { DOCUMENT_TYPE_CATALOG } from "../../domain/documents/DocumentTypes.js";
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
let t: ProvisionedTenant;
const sms = new FakeSms();
let ownerId: string;
let ownerPhone: string;
let driverPhone: string;
let driverToken: string;
let driver: string;
let vehicle: string;

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const asDriver = () => ({ Authorization: `Bearer ${driverToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const drawn = { type: "drawn", png: signaturePng() };

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

const handover = async (body: Record<string, unknown> = {}) => {
  const assignments = await api().get(`/api/v1/assignments?vehicleId=${vehicle}`).set(owner());
  const id = (assignments.body.data as { id: string }[])[0]!.id;
  const res = await api()
    .post(`/api/v1/assignments/${id}/handover-document`)
    .set(owner())
    .send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as {
    id: string;
    number: string;
    code: string;
    status: string;
    signers: { id: string; role: string; status: string }[];
  };
};

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  container.rebind<ISmsGateway[]>(TYPES.SmsGateways).toConstantValue([sms]);
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  ownerId = (await api().get("/api/v1/me").set(owner())).body.data.userId as string;
  ownerPhone = (
    await t.tenant.query<{ phone: string }>("select phone from users where id = $1", [ownerId])
  )[0]!.phone;
  await api()
    .put("/api/v1/settings/notifications/sms")
    .set(owner())
    .send({ provider: "arkesel", senderId: "AutoFleet", credentials: { apiKey: "k" } });
  await api().patch("/api/v1/settings/notifications").set(owner()).send({ quietHours: null });

  driverPhone = `+23324${digits(7)}`;
  driver = (
    await api()
      .post("/api/v1/drivers")
      .set(owner())
      .send({
        firstName: "Efua",
        lastName: "Quaye",
        phone: driverPhone,
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
  const access = await api().post(`/api/v1/drivers/${driver}/app-access`).set(owner());
  const token = /#token=([A-Za-z0-9_-]+)/.exec(access.body.data.invitation.webUrl as string)![1]!;
  driverToken = (
    await api()
      .post("/api/v1/auth/invitations/accept")
      .set("X-Tenant", t.slug)
      .send({ token, password: OWNER_PASSWORD })
  ).body.data.accessToken as string;

  vehicle = (
    await api()
      .post("/api/v1/vehicles")
      .set(owner())
      .send({ make: "Nissan", model: "Almera", plateNumber: `GR ${digits(4)}-26`, odometer: 5_000 })
  ).body.data.id as string;
  const settings = await api().get("/api/v1/settings/assignments").set(owner());
  const assigned = await api()
    .post(`/api/v1/vehicles/${vehicle}/assignment`)
    .set(owner())
    .send({
      driverId: driver,
      odometer: 5_000,
      checklist: {
        items: (settings.body.data.handoverItems as { key: string }[]).map((i) => ({
          key: i.key,
          ok: true,
        })),
      },
      terms: { mode: "fixed_target", target: "200.00", frequency: "daily" },
    });
  expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("signing in the system", () => {
  let doc: Awaited<ReturnType<typeof handover>>;

  it("issues a handover for the business and the driver to sign, and asks them", async () => {
    doc = await handover();
    expect(doc).toMatchObject({ status: "pending_signatures" });
    expect(doc.signers.map((s) => [s.role, s.status])).toEqual([
      ["business", "pending"],
      ["driver", "pending"],
    ]);
    expect(await smsTo(driverPhone)).toMatch(
      /please sign Vehicle handover HND-.* in your driver app/,
    );
    const mine = await api().get("/api/v1/me/signatures").set(owner());
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0]).toMatchObject({ document: { id: doc.id }, requireCode: true });
  });

  it("lets the owner read, confirm a code and draw their signature", async () => {
    const business = doc.signers[0]!.id;
    const open = await api().get(`/api/v1/me/signatures/${business}`).set(owner());
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    expect(open.body.data.pdf).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });

    const noCode = await api()
      .post(`/api/v1/me/signatures/${business}/sign`)
      .set(owner())
      .send({ signature: drawn, consent: true });
    expect(noCode.body.error.message).toMatch(/Enter the code/);

    const sent = await api().post(`/api/v1/me/signatures/${business}/code`).set(owner());
    expect(sent.body.data).toMatchObject({ channel: "sms" });
    const again = await api().post(`/api/v1/me/signatures/${business}/code`).set(owner());
    expect(again.body.error.message).toMatch(/wait a minute/);
    const code = /(\d{6}) is your code/.exec(await smsTo(ownerPhone))![1]!;

    const wrong = await api()
      .post(`/api/v1/me/signatures/${business}/sign`)
      .set(owner())
      .send({ code: code === "000000" ? "111111" : "000000", signature: drawn, consent: true });
    expect(wrong.body.error.code).toBe("OTP_INVALID");
    const typed = await api()
      .post(`/api/v1/me/signatures/${business}/sign`)
      .set(owner())
      .send({ code, signature: { type: "typed", name: "Owner" }, consent: true });
    expect(typed.body.error.message).toMatch(/Draw your signature/);

    const signed = await api()
      .post(`/api/v1/me/signatures/${business}/sign`)
      .set(owner())
      .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0)")
      .send({ code, signature: drawn, consent: true });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body.data).toMatchObject({
      signer: { status: "signed", method: "drawn", codeConfirmed: true },
      document: { status: "partially_signed" },
    });
  });

  it("lets the driver sign in the app with an SMS code, which completes the document", async () => {
    const [task] = (await api().get("/api/v1/me/signatures").set(asDriver())).body.data as {
      signer: { id: string };
    }[];
    const sent = await api().post(`/api/v1/me/signatures/${task!.signer.id}/code`).set(asDriver());
    expect(sent.body.data).toMatchObject({ channel: "sms", to: expect.stringContaining("***") });
    const code = /(\d{6}) is your code/.exec(await smsTo(driverPhone))![1]!;
    const log = await api()
      .get(`/api/v1/notification-deliveries?recipientId=${task!.signer.id}`)
      .set(owner());
    expect(log.body.data[0].body).not.toContain(code);

    const signed = await api()
      .post(`/api/v1/me/signatures/${task!.signer.id}/sign`)
      .set(asDriver())
      .set("User-Agent", "AutoforceDriver/1.0 (Android 14)")
      .send({ code, signature: drawn, consent: true });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body.data.document.status).toBe("fully_signed");
  });

  it("keeps the signed copy with its signature record, checkable by its hash", async () => {
    const res = await api().get(`/api/v1/documents/${doc.id}/download?copy=signed`).set(owner());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const bytes = Buffer.from(await (await fetch(res.body.data.url as string)).arrayBuffer());
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(sha).toBe(res.body.data.sha256);

    const check = await api()
      .get(`/api/v1/public/documents/${doc.code}?sha256=${sha}`)
      .set("X-Tenant", t.slug);
    expect(check.body.data).toMatchObject({
      status: "fully_signed",
      signedPdfSha256: sha,
      hashMatches: true,
      signatures: [
        { label: "For the business", status: "signed" },
        { label: "Driver", name: "Efua Quaye", status: "signed" },
      ],
    });
    const detail = await api().get(`/api/v1/documents/${doc.id}`).set(owner());
    expect((detail.body.data.events as { type: string }[]).map((e) => e.type)).toEqual(
      expect.arrayContaining([
        "otp_sent",
        "otp_verified",
        "signed",
        "fully_signed",
        "signed_pdf_rendered",
      ]),
    );
  });

  it("never changes a given signature", async () => {
    await expect(
      t.tenant.query("update document_signers set ip = '1.2.3.4' where document_id = $1", [doc.id]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      t.tenant.query("update documents set status = 'pending_signatures' where id = $1", [doc.id]),
    ).rejects.toThrow(/cannot go from fully_signed/);
  });
});

describe("guests, paper and declining", () => {
  it("lets a guest sign once through their link; an optional witness need not sign", async () => {
    const guestPhone = `+23320${digits(7)}`;
    const def = DOCUMENT_TYPE_CATALOG.transfer_letter;
    const { issuer: _issuer, document: _document, ...data } = def.sample;
    const issued = await t.tenant.run(() =>
      container.get<Documents>(TYPES.Documents).issue(ownerId, {
        type: "transfer_letter",
        subject: { type: "workpay_agreement", id: randomUUID() },
        branchId: null,
        data,
        signers: [
          { role: "owner", party: { type: "user", id: ownerId } },
          { role: "driver", party: { type: "guest", name: "Kofi Guest", phone: guestPhone } },
          {
            role: "witness",
            party: { type: "guest", name: "Ama Witness", email: "witness@example.com" },
          },
        ],
      }),
    );
    expect(issued.signers!.map((s) => [s.role, s.required])).toEqual([
      ["owner", true],
      ["driver", true],
      ["witness", false],
    ]);
    const link = await smsTo(guestPhone);
    const token = /#token=([A-Za-z0-9_-]+)/.exec(link)![1]!;
    const log = await api()
      .get(`/api/v1/notification-deliveries?recipientId=${issued.signers![1]!.id}`)
      .set(owner());
    expect(JSON.stringify(log.body.data)).not.toContain(token);

    const guest = (path: string, body: Record<string, unknown>) =>
      api()
        .post(`/api/v1/public/signing/${path}`)
        .set("X-Tenant", t.slug)
        .send({ token, ...body });
    const open = await guest("open", {});
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    expect(open.body.data).toMatchObject({
      signer: { name: "Kofi Guest" },
      document: { name: "Transfer letter of agreement" },
    });
    await guest("code", {});
    const code = /(\d{6}) is your code/.exec(await smsTo(guestPhone))![1]!;
    const signed = await guest("sign", { code, signature: drawn, consent: true });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body.data.document.status).toBe("partially_signed");
    const reused = await guest("open", {});
    expect(reused.body.error.message).toMatch(/expired or was already used/);

    // The owner's signature completes it: the witness is optional.
    const ownerSigner = issued.signers![0]!.id;
    await api().post(`/api/v1/me/signatures/${ownerSigner}/code`).set(owner());
    const ownerCode = /(\d{6}) is your code/.exec(await smsTo(ownerPhone))![1]!;
    const done = await api()
      .post(`/api/v1/me/signatures/${ownerSigner}/sign`)
      .set(owner())
      .send({ code: ownerCode, signature: drawn, consent: true });
    expect(done.body.data.document.status).toBe("fully_signed");
  });

  it("records signatures made on paper from their scans", async () => {
    const doc = await handover({ replacesId: null });
    for (const signer of doc.signers) {
      const started = await api()
        .post(`/api/v1/documents/${doc.id}/signers/${signer.id}/paper-scans`)
        .set(owner())
        .send({ filename: "signed.pdf", contentType: "application/pdf", sizeBytes: 64 });
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      const scan = Buffer.alloc(64, 0x20);
      Buffer.from("%PDF-1.7\n").copy(scan);
      const upload = started.body.data.upload as {
        method: string;
        url: string;
        headers: Record<string, string>;
      };
      await fetch(upload.url, { method: upload.method, headers: upload.headers, body: scan });
      const done = await api()
        .post(
          `/api/v1/documents/${doc.id}/signers/${signer.id}/paper-scans/${started.body.data.file.id}/complete`,
        )
        .set(owner());
      expect(done.body.data).toMatchObject({ status: "signed", method: "paper" });
    }
    const detail = await api().get(`/api/v1/documents/${doc.id}`).set(owner());
    expect(detail.body.data).toMatchObject({
      status: "fully_signed",
      signedPdfSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("stops a document a required signer declines, and reminds on request", async () => {
    const doc = await handover();
    const reminded = await api().post(`/api/v1/documents/${doc.id}/remind`).set(owner());
    expect(reminded.body.data).toEqual({ reminded: 2 });
    const driverSigner = doc.signers.find((s) => s.role === "driver")!.id;
    const declined = await api()
      .post(`/api/v1/me/signatures/${driverSigner}/decline`)
      .set(asDriver())
      .send({ reason: "The checklist is wrong" });
    expect(declined.body.data).toMatchObject({
      signer: { status: "declined", declineReason: "The checklist is wrong" },
      document: { status: "declined" },
    });
    const late = await api().post(`/api/v1/me/signatures/${doc.signers[0]!.id}/code`).set(owner());
    expect(late.body.error.message).toMatch(/declined and can no longer be signed/);
    // Someone else's signature does not exist for the driver.
    const other = await api().get(`/api/v1/me/signatures/${doc.signers[0]!.id}`).set(asDriver());
    expect(other.status).toBe(404);
  });

  it("can be printed and signed by hand instead", async () => {
    const doc = await handover({ signInSystem: false });
    expect(doc).toMatchObject({ status: "issued", signers: [] });
  });
});
