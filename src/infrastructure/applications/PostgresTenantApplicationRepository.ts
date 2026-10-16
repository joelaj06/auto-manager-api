import {
  TenantApplication,
  type ApplicationStatus,
  type ApprovalOptions,
  type BusinessType,
  type RiskLevel,
  type RiskSignal,
} from "../../domain/entities/TenantApplication.js";
import type {
  ApplicationListQuery,
  ITenantApplicationRepository,
} from "../../domain/repositories/ITenantApplicationRepository.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

type Row = {
  id: string;
  status: ApplicationStatus;
  source: "self" | "assisted";
  business_name: string;
  business_type: BusinessType;
  country: string;
  desired_slug: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  tin: string | null;
  registration_number: string | null;
  expected_branches: number;
  expected_vehicles: number;
  heard_about: string | null;
  referral_code: string | null;
  created_by_staff_id: string | null;
  access_token_hash: string;
  email_verified_at: Date | null;
  phone_verified_at: Date | null;
  submitted_at: Date | null;
  risk_level: RiskLevel;
  risk_signals: RiskSignal[];
  assigned_to: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  decision_reason: string | null;
  reapply_after: Date | null;
  approval_options: ApprovalOptions | null;
  created_ip: string | null;
  created_user_agent: string | null;
  terms_accepted_at: Date;
  created_at: Date;
};

const COLUMNS = `id, status, source, business_name, business_type, country,
  desired_slug::text as desired_slug, contact_name, contact_email::text as contact_email,
  contact_phone, tin, registration_number, expected_branches, expected_vehicles, heard_about,
  referral_code, created_by_staff_id, access_token_hash, email_verified_at, phone_verified_at,
  submitted_at, risk_level, risk_signals, assigned_to, reviewed_by, reviewed_at, decision_reason,
  reapply_after, approval_options, created_ip::text as created_ip, created_user_agent,
  terms_accepted_at, created_at`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toEntity = (r: Row) =>
  TenantApplication.restore({
    id: r.id,
    status: r.status,
    source: r.source,
    details: {
      businessName: r.business_name,
      businessType: r.business_type,
      country: r.country,
      desiredSlug: r.desired_slug,
      contactName: r.contact_name,
      contactEmail: r.contact_email,
      contactPhone: r.contact_phone,
      tin: r.tin,
      registrationNumber: r.registration_number,
      expectedBranches: r.expected_branches,
      expectedVehicles: r.expected_vehicles,
      heardAbout: r.heard_about,
      referralCode: r.referral_code,
    },
    createdByStaffId: r.created_by_staff_id,
    accessTokenHash: r.access_token_hash,
    emailVerifiedAt: r.email_verified_at,
    phoneVerifiedAt: r.phone_verified_at,
    submittedAt: r.submitted_at,
    riskLevel: r.risk_level,
    riskSignals: r.risk_signals,
    assignedTo: r.assigned_to,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    decisionReason: r.decision_reason,
    reapplyAfter: r.reapply_after,
    approvalOptions: r.approval_options,
    createdIp: r.created_ip,
    createdUserAgent: r.created_user_agent,
    termsAcceptedAt: r.terms_accepted_at,
    createdAt: r.created_at,
  });

export class PostgresTenantApplicationRepository implements ITenantApplicationRepository {
  constructor(private readonly db: PlatformDb) {}

  findById(id: string): Promise<TenantApplication | null> {
    return this.one(id, "");
  }

  lockById(id: string): Promise<TenantApplication | null> {
    return this.one(id, " for update");
  }

  async rotateAccessToken(id: string, tokenHash: string): Promise<void> {
    await this.db.query(
      "update tenant_applications set access_token_hash = $2, updated_at = now() where id = $1",
      [id, tokenHash],
    );
  }

  async list(query: ApplicationListQuery): Promise<TenantApplication[]> {
    const search = query.search?.trim();
    const { rows } = await this.db.query<Row>(
      `select ${COLUMNS} from tenant_applications
        where ($1::text is null or status = $1)
          and ($2::uuid is null or assigned_to = $2)
          and ($3::uuid is null or id < $3)
          and ($4::text is null
               or business_name ilike '%' || $4 || '%' or desired_slug ilike '%' || $4 || '%'
               or contact_email ilike '%' || $4 || '%' or contact_phone like '%' || $4 || '%')
        order by id desc
        limit $5`,
      [
        query.status ?? null,
        query.assignedTo ?? null,
        query.before ?? null,
        // ILIKE wildcards in the search text are matched literally.
        search === undefined || search === "" ? null : search.replace(/[\\%_]/g, (c) => `\\${c}`),
        query.limit,
      ],
    );
    return rows.map(toEntity);
  }

  async save(application: TenantApplication): Promise<void> {
    const s = application.snapshot();
    const d = s.details;
    await this.db.query(
      `insert into tenant_applications
         (id, status, source, business_name, business_type, country, desired_slug, contact_name,
          contact_email, contact_phone, tin, registration_number, expected_branches,
          expected_vehicles, heard_about, referral_code, created_by_staff_id, access_token_hash,
          email_verified_at, phone_verified_at, submitted_at, risk_level, risk_signals,
          assigned_to, reviewed_by, reviewed_at, decision_reason, reapply_after, approval_options,
          created_ip, created_user_agent, terms_accepted_at, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
               $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33)
       on conflict (id) do update set
         status = excluded.status, business_name = excluded.business_name, tin = excluded.tin,
         registration_number = excluded.registration_number,
         expected_branches = excluded.expected_branches,
         expected_vehicles = excluded.expected_vehicles,
         email_verified_at = excluded.email_verified_at,
         phone_verified_at = excluded.phone_verified_at, submitted_at = excluded.submitted_at,
         assigned_to = excluded.assigned_to, reviewed_by = excluded.reviewed_by,
         reviewed_at = excluded.reviewed_at, decision_reason = excluded.decision_reason,
         reapply_after = excluded.reapply_after, approval_options = excluded.approval_options,
         updated_at = now()`,
      [
        s.id,
        s.status,
        s.source,
        d.businessName,
        d.businessType,
        d.country,
        d.desiredSlug,
        d.contactName,
        d.contactEmail,
        d.contactPhone,
        d.tin,
        d.registrationNumber,
        d.expectedBranches,
        d.expectedVehicles,
        d.heardAbout,
        d.referralCode,
        s.createdByStaffId,
        s.accessTokenHash,
        s.emailVerifiedAt,
        s.phoneVerifiedAt,
        s.submittedAt,
        s.riskLevel,
        JSON.stringify(s.riskSignals),
        s.assignedTo,
        s.reviewedBy,
        s.reviewedAt,
        s.decisionReason,
        s.reapplyAfter,
        s.approvalOptions === null ? null : JSON.stringify(s.approvalOptions),
        s.createdIp,
        s.createdUserAgent?.slice(0, 512) ?? null,
        s.termsAcceptedAt,
        s.createdAt,
      ],
    );
  }

  private async one(id: string, lock: string): Promise<TenantApplication | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<Row>(
      `select ${COLUMNS} from tenant_applications where id = $1${lock}`,
      [id],
    );
    return rows[0] === undefined ? null : toEntity(rows[0]);
  }
}
