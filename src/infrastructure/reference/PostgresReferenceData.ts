import type {
  IReferenceData,
  VehicleMake,
  VehicleModel,
} from "../../application/ports/IReferenceData.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MakeRow = { id: string; name: string; active: boolean };
type ModelRow = { id: string; make_id: string; name: string; active: boolean };
const toMake = (r: MakeRow): VehicleMake => ({ id: r.id, name: r.name, active: r.active });
const toModel = (r: ModelRow): VehicleModel => ({
  id: r.id,
  makeId: r.make_id,
  name: r.name,
  active: r.active,
});

/** Vehicle makes and models in the platform database. */
export class PostgresReferenceData implements IReferenceData {
  constructor(private readonly db: PlatformDb) {}

  async vehicleMakes(
    query: Readonly<{ q?: string; includeInactive?: boolean }>,
  ): Promise<VehicleMake[]> {
    const { rows } = await this.db.query<MakeRow>(
      `select id, name::text as name, active from vehicle_makes
        where ($1::boolean or active)
          and ($2::text is null or strpos(lower(name::text), lower($2)) > 0)
        order by sort, name`,
      [query.includeInactive === true, query.q ?? null],
    );
    return rows.map(toMake);
  }

  async vehicleMake(id: string): Promise<VehicleMake | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<MakeRow>(
      "select id, name::text as name, active from vehicle_makes where id = $1",
      [id],
    );
    return rows[0] === undefined ? null : toMake(rows[0]);
  }

  async vehicleModels(makeId: string, includeInactive = false): Promise<VehicleModel[]> {
    if (!UUID.test(makeId)) return [];
    const { rows } = await this.db.query<ModelRow>(
      `select id, make_id, name::text as name, active from vehicle_models
        where make_id = $1 and ($2::boolean or active)
        order by sort, name`,
      [makeId, includeInactive],
    );
    return rows.map(toModel);
  }

  async addVehicleMake(name: string): Promise<VehicleMake> {
    const { rows } = await this.db.query<MakeRow>(
      `insert into vehicle_makes (name, sort)
       values ($1, coalesce((select max(sort) + 1 from vehicle_makes), 0))
       returning id, name::text as name, active`,
      [name],
    );
    return toMake(rows[0]!);
  }

  async addVehicleModel(makeId: string, name: string): Promise<VehicleModel> {
    const { rows } = await this.db.query<ModelRow>(
      `insert into vehicle_models (make_id, name, sort)
       values ($1, $2, coalesce((select max(sort) + 1 from vehicle_models where make_id = $1), 0))
       returning id, make_id, name::text as name, active`,
      [makeId, name],
    );
    return toModel(rows[0]!);
  }

  async vehicleMakeNameTaken(name: string): Promise<boolean> {
    const { rows } = await this.db.query<{ taken: boolean }>(
      "select exists (select 1 from vehicle_makes where name = $1::citext) as taken",
      [name],
    );
    return rows[0]?.taken === true;
  }

  async vehicleModelNameTaken(makeId: string, name: string): Promise<boolean> {
    const { rows } = await this.db.query<{ taken: boolean }>(
      "select exists (select 1 from vehicle_models where make_id = $1 and name = $2::citext) as taken",
      [makeId, name],
    );
    return rows[0]?.taken === true;
  }
}
