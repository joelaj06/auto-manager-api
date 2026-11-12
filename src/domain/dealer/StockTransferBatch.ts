import { StockRuleError } from "./StockUnit.js";

/** The most vehicles one transfer moves. */
export const MAX_BATCH_TRANSFER = 100;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type StockTransferBatchProps = Readonly<{
  id: string;
  reference: string;
  fromBranchId: string;
  toBranchId: string;
  transferredOn: string;
  reason: string;
  vehicleIds: readonly string[];
  transferredBy: string | null;
  createdAt: Date;
}>;

/**
 * Several stock vehicles sent from one branch to another under one reference (docs/10 §2,
 * decision 542): every vehicle leaves the same branch for the same branch on the same day for
 * the same reason, and each keeps its own transfer record pointing at the batch.
 */
export class StockTransferBatch {
  private constructor(private readonly props: StockTransferBatchProps) {}

  static create(input: StockTransferBatchProps): StockTransferBatch {
    const ids = [...new Set(input.vehicleIds)];
    if (ids.length !== input.vehicleIds.length)
      throw new StockRuleError("A vehicle is named twice");
    StockTransferBatch.assertCount(ids.length);
    if (input.fromBranchId === input.toBranchId)
      throw new StockRuleError("The vehicles are already there");
    if (!DATE.test(input.transferredOn))
      throw new StockRuleError("The transfer date is YYYY-MM-DD");
    const reason = input.reason.trim();
    if (reason.length < 3) throw new StockRuleError("Give a reason");
    return new StockTransferBatch({ ...input, reason, vehicleIds: ids });
  }

  /** How many vehicles one transfer may move. */
  static assertCount(count: number): void {
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_BATCH_TRANSFER)
      throw new StockRuleError(`Transfer 1 to ${MAX_BATCH_TRANSFER} vehicles at a time`);
  }

  get id(): string {
    return this.props.id;
  }

  get vehicleIds(): readonly string[] {
    return this.props.vehicleIds;
  }

  snapshot(): StockTransferBatchProps {
    return this.props;
  }
}
