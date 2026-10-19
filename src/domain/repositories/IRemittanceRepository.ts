import type { Remittance } from "../remittances/Remittance.js";

/** Remittances of the current tenant (tenant unit of work). */
export interface IRemittanceRepository {
  findById(id: string): Promise<Remittance | null>;
  lockById(id: string): Promise<Remittance | null>;
  save(remittance: Remittance): Promise<void>;
}
