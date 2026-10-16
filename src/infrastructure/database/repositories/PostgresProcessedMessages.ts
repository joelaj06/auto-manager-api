import type { IProcessedMessages } from "../../../application/ports/IProcessedMessages.js";
import type { PostgresTransactionContext } from "../postgres/PostgresTransactionContext.js";

export class PostgresProcessedMessages implements IProcessedMessages {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async markProcessed(key: string): Promise<boolean> {
    // A concurrent delivery of the same message waits on the key's lock here and then sees the
    // row, so only one of them proceeds.
    const { rowCount } = await this.transactions
      .current()
      .query("insert into processed_messages (key) values ($1) on conflict (key) do nothing", [
        key,
      ]);
    return rowCount === 1;
  }
}
