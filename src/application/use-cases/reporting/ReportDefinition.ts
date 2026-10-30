import type {
  ParamValues,
  ReportCategory,
  ReportParam,
  ReportTable,
} from "../../../domain/reporting/Report.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";

/**
 * A report in the catalogue (docs/14 §2), defined in code: who may run it, the parameters it
 * takes and the table it returns. `run` checks branch scope and throws on bad input like any
 * use case; the engine renders the table as JSON, CSV, XLSX or PDF.
 */
export interface ReportDefinition {
  /** Stable, snake_case: `dealer_gross_profit`. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: ReportCategory;
  readonly permission: PermissionKey;
  readonly params: readonly ReportParam[];
  /** Wide tables print across the page. */
  readonly landscape?: boolean;
  run(actor: Principal, params: ParamValues): Promise<ReportTable>;
}

/** The usual period parameters. */
export const PERIOD_PARAMS: readonly ReportParam[] = [
  { key: "from", label: "From", type: "date", required: false },
  { key: "to", label: "To", type: "date", required: false },
  { key: "branchId", label: "Branch", type: "uuid", required: false },
];

/** `from`/`to` passed on only when given. */
export function periodOf(
  params: ParamValues,
): Readonly<{ from?: string; to?: string; branchId?: string }> {
  return {
    ...(params.from === undefined ? {} : { from: params.from }),
    ...(params.to === undefined ? {} : { to: params.to }),
    ...(params.branchId === undefined ? {} : { branchId: params.branchId }),
  };
}
