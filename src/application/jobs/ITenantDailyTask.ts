/**
 * Work a module does once a day in each tenant (inside the tenant's daily job, in its context):
 * recurring expenses, later reminders and expected remittances.
 */
export interface ITenantDailyTask {
  readonly name: string;
  run(localDate: string): Promise<void>;
}
