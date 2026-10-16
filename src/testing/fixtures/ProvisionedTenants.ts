import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import type { IJobHandler } from "../../application/jobs/IJobHandler.js";
import { TenantApplication } from "../../domain/entities/TenantApplication.js";
import type { ITenantApplicationRepository } from "../../domain/repositories/ITenantApplicationRepository.js";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import { TYPES } from "../../framework/dependency-injection/types.js";
import type { TestStaff } from "./StaffFixtures.js";
import { TestTenant } from "./TenantFixtures.js";

export type ProvisionedTenant = Readonly<{
  tenant: TestTenant;
  tenantId: string;
  slug: string;
  ownerEmail: string;
  ownerAccessToken: string;
  ownerRefreshToken: string;
}>;

export const OWNER_PASSWORD = "correct horse battery staple";

/**
 * A fully provisioned tenant with a signed-in owner, created through the real flow: a verified
 * application, staff approval over HTTP, the provisioning saga, and the owner's welcome link.
 */
export class ProvisionedTenants {
  constructor(
    private readonly container: Container,
    private readonly app: Express,
    private readonly approver: TestStaff,
  ) {}

  async create(): Promise<ProvisionedTenant> {
    const unique = randomUUID().slice(0, 8);
    const ownerEmail = `owner-${unique}@example.com`;
    const application = TenantApplication.submit({
      id: randomUUID(),
      details: {
        businessName: `Test Fleet ${unique}`,
        businessType: "fleet",
        country: "GH",
        desiredSlug: `fleet-${unique}`,
        contactName: "Test Owner",
        contactEmail: ownerEmail,
        contactPhone: `+23324${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`,
        tin: null,
        registrationNumber: null,
        expectedBranches: 2,
        expectedVehicles: 10,
        heardAbout: null,
        referralCode: null,
      },
      source: "self",
      createdByStaffId: null,
      accessTokenHash: randomUUID().replaceAll("-", ""),
      risk: { level: "low", signals: [] },
      ip: null,
      userAgent: null,
      now: new Date(),
    });
    application.markVerified("email", new Date());
    application.markVerified("phone", new Date());
    await this.container
      .get<ITenantApplicationRepository>(TYPES.TenantApplicationRepository)
      .save(application);

    const approved = await request(this.app)
      .post(`/api/platform/v1/applications/${application.id}/approve`)
      .set("Authorization", `Bearer ${this.approver.accessToken}`)
      .send({});
    if (approved.status !== 204)
      throw new Error(`Approval failed: ${JSON.stringify(approved.body)}`);

    const platform = this.container.get<pg.Pool>(TYPES.PlatformDatabasePool);
    const { rows } = await platform.query<{ tenant_id: string }>(
      "select tenant_id from tenant_applications where id = $1",
      [application.id],
    );
    const tenantId = rows[0]!.tenant_id;
    const saga = this.container
      .get<IJobHandler[]>(TYPES.JobHandlers)
      .find((h) => h.job === "tenant.provision") as IJobHandler<"tenant.provision">;
    await saga.handle({ tenantId }, { jobId: "fixture", attempt: 1 });

    const email = await platform.query<{ body_text: string }>(
      `select body_text from email_deliveries where recipient = $1 and template = 'tenant.welcome_owner'
        order by created_at desc limit 1`,
      [ownerEmail],
    );
    const token = /#token=([A-Za-z0-9_-]+)/.exec(email.rows[0]!.body_text)![1]!;
    const slug = application.details.desiredSlug;
    const accepted = await request(this.app)
      .post("/api/v1/auth/invitations/accept")
      .set("X-Tenant", slug)
      .send({ token, password: OWNER_PASSWORD });
    if (accepted.status !== 200)
      throw new Error(`Owner sign-in failed: ${JSON.stringify(accepted.body)}`);
    const tokens = (accepted.body as { data: { accessToken: string; refreshToken: string } }).data;

    return {
      tenant: new TestTenant(TenantId.from(tenantId), slug, this.container),
      tenantId,
      slug,
      ownerEmail,
      ownerAccessToken: tokens.accessToken,
      ownerRefreshToken: tokens.refreshToken,
    };
  }
}
