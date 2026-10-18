import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { FileService } from "./FileService.js";

/** Daily: removes platform uploads that were started but never completed (and their bytes). */
export class SweepAbandonedFiles implements IJobHandler<"files.sweep"> {
  readonly job = "files.sweep" as const;

  constructor(private readonly deps: Readonly<{ files: FileService; logger: ILogger }>) {}

  async handle(): Promise<void> {
    const removed = await this.deps.files.sweepAbandoned();
    if (removed > 0) this.deps.logger.info("Abandoned platform uploads removed", { removed });
  }
}
