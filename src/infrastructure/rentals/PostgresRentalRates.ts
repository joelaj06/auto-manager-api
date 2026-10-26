import type { IRentalRates, RatePlanFilter } from "../../application/ports/IRentalRates.js";
import {
  DEFAULT_RENTAL_SETTINGS,
  type PromoCode,
  type PublicHoliday,
  type RatePlan,
  type RateSeason,
  type RentalExtra,
  type RentalSettings,
  type RentalZone,
  type VehicleClass,
} from "../../domain/rentals/RentalRates.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (value: string | null) => (value === null ? null : Number(value));
/** numeric(5,2) as the decimal string it was entered as ("25.00" → "25"). */
const percent = (value: string | null) =>
  value === null ? null : value.replace(/\.?0+$/, "") || "0";

type ClassRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  min_driver_age: number | null;
  min_licence_years: number | null;
  sort: number;
  active: boolean;
};

const toClass = (r: ClassRow): VehicleClass => ({
  id: r.id,
  code: r.code,
  name: r.name,
  description: r.description,
  minDriverAge: r.min_driver_age,
  minLicenceYears: r.min_licence_years,
  sort: r.sort,
  active: r.active,
});

type PlanRow = {
  id: string;
  code: string;
  name: string;
  class_id: string | null;
  vehicle_id: string | null;
  branch_id: string | null;
  customer_id: string | null;
  currency: string;
  hourly_minor: string | null;
  daily_minor: string;
  weekend_daily_minor: string | null;
  weekly_minor: string | null;
  monthly_minor: string | null;
  min_hours: number;
  included_km_per_day: number | null;
  extra_km_minor: string | null;
  chauffeur_daily_minor: string | null;
  chauffeur_overnight_minor: string | null;
  chauffeur_out_of_town_minor: string | null;
  tax_code: string | null;
  valid_from: string | null;
  valid_to: string | null;
  active: boolean;
  notes: string | null;
  seasons: {
    id: string;
    name: string;
    starts_on: string;
    ends_on: string;
    adjustment_percent: string;
  }[];
};

const toPlan = (r: PlanRow): RatePlan => ({
  id: r.id,
  code: r.code,
  name: r.name,
  classId: r.class_id,
  vehicleId: r.vehicle_id,
  branchId: r.branch_id,
  customerId: r.customer_id,
  currency: r.currency,
  hourlyMinor: num(r.hourly_minor),
  dailyMinor: Number(r.daily_minor),
  weekendDailyMinor: num(r.weekend_daily_minor),
  weeklyMinor: num(r.weekly_minor),
  monthlyMinor: num(r.monthly_minor),
  minHours: r.min_hours,
  includedKmPerDay: r.included_km_per_day,
  extraKmMinor: num(r.extra_km_minor),
  chauffeurDailyMinor: num(r.chauffeur_daily_minor),
  chauffeurOvernightMinor: num(r.chauffeur_overnight_minor),
  chauffeurOutOfTownMinor: num(r.chauffeur_out_of_town_minor),
  taxCode: r.tax_code,
  validFrom: r.valid_from,
  validTo: r.valid_to,
  active: r.active,
  notes: r.notes,
  seasons: r.seasons.map((s): RateSeason => ({
    id: s.id,
    name: s.name,
    startsOn: s.starts_on,
    endsOn: s.ends_on,
    adjustmentPercent: percent(String(s.adjustment_percent))!,
  })),
});

const PLAN_SELECT = `
  select p.*, p.valid_from::text as valid_from, p.valid_to::text as valid_to,
         coalesce((select json_agg(json_build_object('id', s.id, 'name', s.name,
                     'starts_on', s.starts_on::text, 'ends_on', s.ends_on::text,
                     'adjustment_percent', s.adjustment_percent::text) order by s.starts_on)
                     from rental_rate_seasons s where s.plan_id = p.id), '[]'::json) as seasons
    from rental_rate_plans p`;

type ExtraRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: RentalExtra["category"];
  charge: RentalExtra["charge"];
  price_minor: string;
  max_charge_minor: string | null;
  max_quantity: number;
  tax_code: string | null;
  class_ids: string[];
  sort: number;
  active: boolean;
};

const toExtra = (r: ExtraRow): RentalExtra => ({
  id: r.id,
  code: r.code,
  name: r.name,
  description: r.description,
  category: r.category,
  charge: r.charge,
  priceMinor: Number(r.price_minor),
  maxChargeMinor: num(r.max_charge_minor),
  maxQuantity: r.max_quantity,
  taxCode: r.tax_code,
  classIds: r.class_ids,
  sort: r.sort,
  active: r.active,
});

type ZoneRow = {
  id: string;
  name: string;
  delivery_fee_minor: string;
  collection_fee_minor: string;
  out_of_town_daily_minor: string;
  active: boolean;
};

const toZone = (r: ZoneRow): RentalZone => ({
  id: r.id,
  name: r.name,
  deliveryFeeMinor: Number(r.delivery_fee_minor),
  collectionFeeMinor: Number(r.collection_fee_minor),
  outOfTownDailyMinor: Number(r.out_of_town_daily_minor),
  active: r.active,
});

type PromoRow = {
  id: string;
  code: string;
  description: string | null;
  discount_percent: string | null;
  discount_minor: string | null;
  valid_from: string | null;
  valid_to: string | null;
  min_days: number | null;
  max_uses: number | null;
  used_count: number;
  class_ids: string[];
  active: boolean;
};

const toPromo = (r: PromoRow): PromoCode => ({
  id: r.id,
  code: r.code,
  description: r.description,
  discountPercent: percent(r.discount_percent),
  discountMinor: num(r.discount_minor),
  validFrom: r.valid_from,
  validTo: r.valid_to,
  minDays: r.min_days,
  maxUses: r.max_uses,
  usedCount: r.used_count,
  classIds: r.class_ids,
  active: r.active,
});

const PROMO_SELECT = `select *, valid_from::text as valid_from, valid_to::text as valid_to,
                             discount_percent::text as discount_percent from rental_promo_codes`;

const TAKEN = {
  class: "select 1 from vehicle_classes where code = $1 and id is distinct from $2::uuid",
  plan: "select 1 from rental_rate_plans where code = $1 and id is distinct from $2::uuid",
  extra: "select 1 from rental_extras where code = $1 and id is distinct from $2::uuid",
  zone: "select 1 from rental_zones where name = $1 and id is distinct from $2::uuid",
  promo: "select 1 from rental_promo_codes where code = $1 and id is distinct from $2::uuid",
} as const;

export class PostgresRentalRates implements IRentalRates {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  // --- classes ---

  async classes(): Promise<VehicleClass[]> {
    const { rows } = await this.tx.query<ClassRow>(
      "select * from vehicle_classes order by sort, name",
    );
    return rows.map(toClass);
  }

  async vehicleClass(id: string): Promise<VehicleClass | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<ClassRow>("select * from vehicle_classes where id = $1", [
      id,
    ]);
    return rows[0] === undefined ? null : toClass(rows[0]);
  }

  async saveClass(c: VehicleClass, actorId: string | null): Promise<void> {
    await this.tx.query(
      `insert into vehicle_classes (id, code, name, description, min_driver_age,
         min_licence_years, sort, active, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (id) do update set code = excluded.code, name = excluded.name,
         description = excluded.description, min_driver_age = excluded.min_driver_age,
         min_licence_years = excluded.min_licence_years, sort = excluded.sort,
         active = excluded.active, updated_at = now()`,
      [
        c.id,
        c.code,
        c.name,
        c.description,
        c.minDriverAge,
        c.minLicenceYears,
        c.sort,
        c.active,
        actorId,
      ],
    );
  }

  async classVehicleCounts(): Promise<ReadonlyMap<string, number>> {
    const { rows } = await this.tx.query<{ class_id: string; vehicles: number }>(
      `select rental_class_id as class_id, count(*)::int as vehicles from vehicles
        where rental_class_id is not null and deleted_at is null group by rental_class_id`,
    );
    return new Map(rows.map((r) => [r.class_id, r.vehicles]));
  }

  async vehicleClassId(vehicleId: string): Promise<string | null> {
    const { rows } = await this.tx.query<{ rental_class_id: string | null }>(
      "select rental_class_id from vehicles where id = $1",
      [vehicleId],
    );
    return rows[0]?.rental_class_id ?? null;
  }

  async assignVehicleClass(vehicleId: string, classId: string | null): Promise<void> {
    await this.tx.query(
      "update vehicles set rental_class_id = $2, updated_at = now() where id = $1",
      [vehicleId, classId],
    );
  }

  // --- rate plans ---

  async plans(filter: RatePlanFilter = {}): Promise<RatePlan[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (filter.classId !== undefined) add("p.class_id = ?", filter.classId);
    if (filter.vehicleId !== undefined) add("p.vehicle_id = ?", filter.vehicleId);
    if (filter.customerId !== undefined) add("p.customer_id = ?", filter.customerId);
    if (filter.includeInactive !== true) where.push("p.active");
    const { rows } = await this.tx.query<PlanRow>(
      `${PLAN_SELECT} ${where.length === 0 ? "" : `where ${where.join(" and ")}`}
        order by p.code`,
      params,
    );
    return rows.map(toPlan);
  }

  async plan(id: string): Promise<RatePlan | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<PlanRow>(`${PLAN_SELECT} where p.id = $1`, [id]);
    return rows[0] === undefined ? null : toPlan(rows[0]);
  }

  async savePlan(p: RatePlan, actorId: string | null): Promise<void> {
    await this.tx.query(
      `insert into rental_rate_plans (id, code, name, class_id, vehicle_id, branch_id,
         customer_id, currency, hourly_minor, daily_minor, weekend_daily_minor, weekly_minor,
         monthly_minor, min_hours, included_km_per_day, extra_km_minor, chauffeur_daily_minor,
         chauffeur_overnight_minor, chauffeur_out_of_town_minor, tax_code, valid_from, valid_to,
         active, notes, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19, $20, $21, $22, $23, $24, $25)
       on conflict (id) do update set code = excluded.code, name = excluded.name,
         class_id = excluded.class_id, vehicle_id = excluded.vehicle_id,
         branch_id = excluded.branch_id, customer_id = excluded.customer_id,
         hourly_minor = excluded.hourly_minor, daily_minor = excluded.daily_minor,
         weekend_daily_minor = excluded.weekend_daily_minor, weekly_minor = excluded.weekly_minor,
         monthly_minor = excluded.monthly_minor, min_hours = excluded.min_hours,
         included_km_per_day = excluded.included_km_per_day,
         extra_km_minor = excluded.extra_km_minor,
         chauffeur_daily_minor = excluded.chauffeur_daily_minor,
         chauffeur_overnight_minor = excluded.chauffeur_overnight_minor,
         chauffeur_out_of_town_minor = excluded.chauffeur_out_of_town_minor,
         tax_code = excluded.tax_code, valid_from = excluded.valid_from,
         valid_to = excluded.valid_to, active = excluded.active, notes = excluded.notes,
         updated_at = now()`,
      [
        p.id,
        p.code,
        p.name,
        p.classId,
        p.vehicleId,
        p.branchId,
        p.customerId,
        p.currency,
        p.hourlyMinor,
        p.dailyMinor,
        p.weekendDailyMinor,
        p.weeklyMinor,
        p.monthlyMinor,
        p.minHours,
        p.includedKmPerDay,
        p.extraKmMinor,
        p.chauffeurDailyMinor,
        p.chauffeurOvernightMinor,
        p.chauffeurOutOfTownMinor,
        p.taxCode,
        p.validFrom,
        p.validTo,
        p.active,
        p.notes,
        actorId,
      ],
    );
    await this.tx.query("delete from rental_rate_seasons where plan_id = $1", [p.id]);
    for (const s of p.seasons)
      await this.tx.query(
        `insert into rental_rate_seasons (id, plan_id, name, starts_on, ends_on, adjustment_percent)
         values ($1, $2, $3, $4, $5, $6)`,
        [s.id, p.id, s.name, s.startsOn, s.endsOn, s.adjustmentPercent],
      );
  }

  // --- extras ---

  async extras(): Promise<RentalExtra[]> {
    const { rows } = await this.tx.query<ExtraRow>(
      "select * from rental_extras order by sort, name",
    );
    return rows.map(toExtra);
  }

  async extra(id: string): Promise<RentalExtra | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<ExtraRow>("select * from rental_extras where id = $1", [
      id,
    ]);
    return rows[0] === undefined ? null : toExtra(rows[0]);
  }

  async saveExtra(e: RentalExtra, actorId: string | null): Promise<void> {
    await this.tx.query(
      `insert into rental_extras (id, code, name, description, category, charge, price_minor,
         max_charge_minor, max_quantity, tax_code, class_ids, sort, active, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid[], $12, $13, $14)
       on conflict (id) do update set code = excluded.code, name = excluded.name,
         description = excluded.description, category = excluded.category,
         charge = excluded.charge, price_minor = excluded.price_minor,
         max_charge_minor = excluded.max_charge_minor, max_quantity = excluded.max_quantity,
         tax_code = excluded.tax_code, class_ids = excluded.class_ids, sort = excluded.sort,
         active = excluded.active, updated_at = now()`,
      [
        e.id,
        e.code,
        e.name,
        e.description,
        e.category,
        e.charge,
        e.priceMinor,
        e.maxChargeMinor,
        e.maxQuantity,
        e.taxCode,
        e.classIds,
        e.sort,
        e.active,
        actorId,
      ],
    );
  }

  // --- zones ---

  async zones(): Promise<RentalZone[]> {
    const { rows } = await this.tx.query<ZoneRow>("select * from rental_zones order by name");
    return rows.map(toZone);
  }

  async zone(id: string): Promise<RentalZone | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<ZoneRow>("select * from rental_zones where id = $1", [id]);
    return rows[0] === undefined ? null : toZone(rows[0]);
  }

  async saveZone(z: RentalZone, actorId: string | null): Promise<void> {
    await this.tx.query(
      `insert into rental_zones (id, name, delivery_fee_minor, collection_fee_minor,
         out_of_town_daily_minor, active, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do update set name = excluded.name,
         delivery_fee_minor = excluded.delivery_fee_minor,
         collection_fee_minor = excluded.collection_fee_minor,
         out_of_town_daily_minor = excluded.out_of_town_daily_minor, active = excluded.active,
         updated_at = now()`,
      [
        z.id,
        z.name,
        z.deliveryFeeMinor,
        z.collectionFeeMinor,
        z.outOfTownDailyMinor,
        z.active,
        actorId,
      ],
    );
  }

  // --- promo codes ---

  async promos(): Promise<PromoCode[]> {
    const { rows } = await this.tx.query<PromoRow>(`${PROMO_SELECT} order by created_at desc`);
    return rows.map(toPromo);
  }

  async promo(id: string): Promise<PromoCode | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<PromoRow>(`${PROMO_SELECT} where id = $1`, [id]);
    return rows[0] === undefined ? null : toPromo(rows[0]);
  }

  async promoByCode(code: string): Promise<PromoCode | null> {
    const { rows } = await this.tx.query<PromoRow>(`${PROMO_SELECT} where code = $1`, [code]);
    return rows[0] === undefined ? null : toPromo(rows[0]);
  }

  async savePromo(p: PromoCode, actorId: string | null): Promise<void> {
    await this.tx.query(
      `insert into rental_promo_codes (id, code, description, discount_percent, discount_minor,
         valid_from, valid_to, min_days, max_uses, used_count, class_ids, active, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid[], $12, $13)
       on conflict (id) do update set code = excluded.code, description = excluded.description,
         discount_percent = excluded.discount_percent, discount_minor = excluded.discount_minor,
         valid_from = excluded.valid_from, valid_to = excluded.valid_to,
         min_days = excluded.min_days, max_uses = excluded.max_uses,
         class_ids = excluded.class_ids, active = excluded.active, updated_at = now()`,
      [
        p.id,
        p.code,
        p.description,
        p.discountPercent,
        p.discountMinor,
        p.validFrom,
        p.validTo,
        p.minDays,
        p.maxUses,
        p.usedCount,
        p.classIds,
        p.active,
        actorId,
      ],
    );
  }

  async taken(
    kind: "class" | "plan" | "extra" | "zone" | "promo",
    value: string,
    exceptId: string | null,
  ): Promise<boolean> {
    const { rows } = await this.tx.query(TAKEN[kind], [value, exceptId]);
    return rows.length > 0;
  }

  // --- holidays ---

  async holidays(from: string, to: string): Promise<PublicHoliday[]> {
    const { rows } = await this.tx.query<{ id: string; date: string; name: string }>(
      `select id, date::text as date, name from public_holidays
        where date between $1 and $2 order by date`,
      [from, to],
    );
    return rows;
  }

  async holiday(id: string): Promise<PublicHoliday | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<PublicHoliday>(
      "select id, date::text as date, name from public_holidays where id = $1",
      [id],
    );
    return rows[0] ?? null;
  }

  async holidayOn(date: string): Promise<PublicHoliday | null> {
    const { rows } = await this.tx.query<PublicHoliday>(
      "select id, date::text as date, name from public_holidays where date = $1",
      [date],
    );
    return rows[0] ?? null;
  }

  async saveHoliday(h: PublicHoliday, actorId: string | null): Promise<void> {
    await this.tx.query(
      `insert into public_holidays (id, date, name, created_by) values ($1, $2, $3, $4)
       on conflict (id) do update set date = excluded.date, name = excluded.name`,
      [h.id, h.date, h.name, actorId],
    );
  }

  async deleteHoliday(id: string): Promise<void> {
    await this.tx.query("delete from public_holidays where id = $1", [id]);
  }

  // --- settings ---

  async settings(): Promise<RentalSettings> {
    const { rows } = await this.tx.query<{ rentals: Partial<RentalSettings> | null }>(
      "select settings->'rentals' as rentals from organisation",
    );
    return { ...DEFAULT_RENTAL_SETTINGS, ...(rows[0]?.rentals ?? {}) };
  }

  async saveSettings(s: RentalSettings): Promise<void> {
    await this.tx.query(
      "update organisation set settings = jsonb_set(settings, '{rentals}', $1::jsonb), updated_at = now()",
      [JSON.stringify(s)],
    );
  }
}
