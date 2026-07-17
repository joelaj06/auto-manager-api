import mongoose from "mongoose";
import { createTenantSystemModel } from "./TenantSystemModel";
import { createSubscriptionSystemModel } from "./SubscriptionSystemModel";
import { createAuditLogSystemModel } from "./AuditLogSystemModel";

export const createSystemModels = (
  connection: mongoose.Connection | mongoose.Mongoose,
) => ({
  Tenant: createTenantSystemModel(connection),
  Subscription: createSubscriptionSystemModel(connection),
  AuditLog: createAuditLogSystemModel(connection),
});

export * from "./TenantSystemModel";
export * from "./SubscriptionSystemModel";
export * from "./AuditLogSystemModel";
