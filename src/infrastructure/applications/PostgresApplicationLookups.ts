import type {
  IApplicationLookups,
  SimilarApplication,
} from "../../application/ports/IApplicationLookups.js";
import type { ApplicationStatus } from "../../domain/entities/TenantApplication.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

const OPEN = ["pending_verification", "pending_review", "needs_info"];

export class PostgresApplicationLookups implements IApplicationLookups {
  constructor(private readonly db: PlatformDb) {}

  async slugTaken(slug: string, exceptApplicationId?: string): Promise<boolean> {
    const { rows } = await this.db.query<{ taken: boolean }>(
      `select exists (select 1 from tenants where slug = $1)
           or exists (select 1 from tenant_applications
                       where desired_slug = $1 and status <> 'rejected'
                         and ($2::uuid is null or id <> $2)) as taken`,
      [slug, exceptApplicationId ?? null],
    );
    return rows[0]?.taken === true;
  }

  async openApplicationExists(email: string, phone: string): Promise<boolean> {
    const { rows } = await this.db.query<{ open: boolean }>(
      `select exists (select 1 from tenant_applications
                       where (contact_email = $1 or contact_phone = $2) and status = any($3)) as open`,
      [email, phone, OPEN],
    );
    return rows[0]?.open === true;
  }

  async reapplyBlockedUntil(email: string, phone: string, now: Date): Promise<Date | null> {
    const { rows } = await this.db.query<{ until: Date | null }>(
      `select max(reapply_after) as until from tenant_applications
        where (contact_email = $1 or contact_phone = $2) and status = 'rejected'
          and reapply_after > $3`,
      [email, phone, now],
    );
    return rows[0]?.until ?? null;
  }

  async applicationsFromIpSince(ip: string, since: Date): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>(
      "select count(*) as n from tenant_applications where created_ip = $1::inet and created_at >= $2",
      [ip, since],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async similar(params: {
    excludeId?: string;
    email: string;
    phone: string;
    businessName: string;
  }): Promise<SimilarApplication[]> {
    const { rows } = await this.db.query<{
      id: string;
      business_name: string;
      status: ApplicationStatus;
      created_at: Date;
      email_match: boolean;
      phone_match: boolean;
      name_match: boolean;
    }>(
      `select id, business_name, status, created_at,
              contact_email = $2 as email_match,
              contact_phone = $3 as phone_match,
              lower(trim(business_name)) = lower(trim($4)) as name_match
         from tenant_applications
        where ($1::uuid is null or id <> $1)
          and (contact_email = $2 or contact_phone = $3 or lower(trim(business_name)) = lower(trim($4)))
        order by created_at desc
        limit 20`,
      [params.excludeId ?? null, params.email, params.phone, params.businessName],
    );
    return rows.map((r) => ({
      id: r.id,
      businessName: r.business_name,
      status: r.status,
      createdAt: r.created_at,
      matchedOn: [
        ...(r.email_match ? (["email"] as const) : []),
        ...(r.phone_match ? (["phone"] as const) : []),
        ...(r.name_match ? (["business_name"] as const) : []),
      ],
    }));
  }

  async assistedByPartnerSince(partnerId: string, since: Date): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>(
      `select count(*) as n from tenant_applications
        where partner_id = $1 and source = 'assisted' and created_at >= $2`,
      [partnerId, since],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async tenantsNamed(businessName: string): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>(
      "select count(*) as n from tenants where lower(trim(name)) = lower(trim($1))",
      [businessName],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
