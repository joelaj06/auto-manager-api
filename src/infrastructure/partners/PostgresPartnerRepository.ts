import { Partner, type PartnerStatus } from "../../domain/entities/Partner.js";
import type { IPartnerRepository } from "../../domain/repositories/IPartnerRepository.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

type Row = {
  id: string;
  name: string;
  kind: "individual" | "company";
  contact_name: string;
  email: string;
  phone: string;
  region: string | null;
  address: string | null;
  tin: string | null;
  status: PartnerStatus;
  status_reason: string | null;
  status_changed_at: Date | null;
  trusted: boolean;
  referral_code: string;
  capabilities: string[];
  created_at: Date;
  version: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SELECT = `select p.id, p.name, p.kind, p.contact_name, p.email::text as email, p.phone,
       p.region, p.address, p.tin, p.status, p.status_reason, p.status_changed_at, p.trusted,
       p.referral_code, p.created_at, p.version,
       coalesce((select array_agg(g.permission_key order by g.permission_key)
                   from partner_permission_grants g where g.partner_id = p.id), '{}') as capabilities
  from partners p`;

const toEntity = (r: Row) =>
  Partner.restore({
    id: r.id,
    profile: {
      name: r.name,
      kind: r.kind,
      contactName: r.contact_name,
      email: r.email,
      phone: r.phone,
      region: r.region,
      address: r.address,
      tin: r.tin,
    },
    status: r.status,
    statusReason: r.status_reason,
    statusChangedAt: r.status_changed_at,
    trusted: r.trusted,
    referralCode: r.referral_code,
    capabilities: r.capabilities,
    createdAt: r.created_at,
    version: r.version,
  });

export class PostgresPartnerRepository implements IPartnerRepository {
  constructor(private readonly db: PlatformDb) {}

  findById(id: string): Promise<Partner | null> {
    return UUID.test(id) ? this.one("p.id = $1", id) : Promise.resolve(null);
  }

  lockById(id: string): Promise<Partner | null> {
    return UUID.test(id) ? this.one("p.id = $1", id, " for update of p") : Promise.resolve(null);
  }

  findByReferralCode(code: string): Promise<Partner | null> {
    return this.one("p.referral_code = upper($1)", code);
  }

  async referralCodeTaken(code: string, exceptPartnerId?: string): Promise<boolean> {
    const { rows } = await this.db.query<{ taken: boolean }>(
      `select exists (select 1 from partners
                       where referral_code = upper($1) and ($2::uuid is null or id <> $2)) as taken`,
      [code, exceptPartnerId ?? null],
    );
    return rows[0]?.taken === true;
  }

  async emailTaken(email: string, exceptPartnerId?: string): Promise<boolean> {
    const { rows } = await this.db.query<{ taken: boolean }>(
      `select exists (select 1 from partners
                       where email = $1::citext and ($2::uuid is null or id <> $2)) as taken`,
      [email, exceptPartnerId ?? null],
    );
    return rows[0]?.taken === true;
  }

  async save(partner: Partner, actorId: string | null): Promise<void> {
    const p = partner.snapshot();
    await this.db.query(
      `insert into partners
         (id, name, kind, contact_name, email, phone, region, address, tin, status, status_reason,
          status_changed_at, trusted, referral_code, created_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       on conflict (id) do update set
         name = excluded.name, kind = excluded.kind, contact_name = excluded.contact_name,
         email = excluded.email, phone = excluded.phone, region = excluded.region,
         address = excluded.address, tin = excluded.tin, status = excluded.status,
         status_reason = excluded.status_reason, status_changed_at = excluded.status_changed_at,
         trusted = excluded.trusted, referral_code = excluded.referral_code,
         updated_at = now(), version = partners.version + 1`,
      [
        p.id,
        p.profile.name,
        p.profile.kind,
        p.profile.contactName,
        p.profile.email,
        p.profile.phone,
        p.profile.region,
        p.profile.address,
        p.profile.tin,
        p.status,
        p.statusReason,
        p.statusChangedAt,
        p.trusted,
        p.referralCode,
        actorId,
        p.createdAt,
      ],
    );
    await this.db.query(
      "delete from partner_permission_grants where partner_id = $1 and permission_key <> all($2)",
      [p.id, p.capabilities],
    );
    await this.db.query(
      `insert into partner_permission_grants (partner_id, permission_key, granted_by)
       select $1, unnest($2::text[]), $3
       on conflict do nothing`,
      [p.id, p.capabilities, actorId],
    );
  }

  private async one(condition: string, value: string, lock = ""): Promise<Partner | null> {
    const { rows } = await this.db.query<Row>(`${SELECT} where ${condition}${lock}`, [value]);
    return rows[0] === undefined ? null : toEntity(rows[0]);
  }
}
