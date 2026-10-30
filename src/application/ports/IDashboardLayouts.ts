import type { DashboardRole } from "../../domain/reporting/DashboardLayout.js";

export type StoredLayout = Readonly<{
  role: DashboardRole;
  widgets: readonly string[];
  updatedBy: string | null;
  updatedAt: Date;
}>;

/** The business's own widget lists of role dashboards (the defaults live in code). */
export interface IDashboardLayouts {
  list(): Promise<StoredLayout[]>;
  get(role: DashboardRole): Promise<StoredLayout | null>;
  save(layout: StoredLayout): Promise<void>;
  remove(role: DashboardRole): Promise<void>;
}
