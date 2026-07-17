import mongoose, { Model } from "mongoose";
import { ITenant } from "../../../../entities/Tenant";

const tenantSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    subdomain: { type: String, required: false },
    domains: { type: [String], default: [] },
    databaseName: { type: String, required: true },
    databaseUri: { type: String, required: false },
    status: {
      type: String,
      enum: ["active", "inactive", "suspended", "archived"],
      default: "inactive",
    },
    subscriptionStatus: {
      type: String,
      enum: ["active", "expired", "pending"],
      default: "pending",
    },
    subscriptionExpiresAt: { type: Date, required: false },
    isDeleted: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

export const createTenantSystemModel = (
  connection: mongoose.Connection | mongoose.Mongoose = mongoose,
): Model<ITenant & mongoose.Document> => {
  const modelName = "Tenant";
  const targetConnection =
    connection instanceof mongoose.Mongoose
      ? connection
      : (connection as mongoose.Connection);
  const existingModel = targetConnection.models[modelName];
  if (existingModel) return existingModel as Model<ITenant & mongoose.Document>;
  return targetConnection.model<
    ITenant & mongoose.Document,
    Model<ITenant & mongoose.Document>
  >(modelName, tenantSchema);
};

export const TenantSystemModel = createTenantSystemModel();
export default TenantSystemModel;

export const TenantMapper = {
  toDtoCreation: (payload: Partial<ITenant>) => ({
    name: payload.name,
    slug: payload.slug,
    subdomain: payload.subdomain ?? payload.slug,
    domains: payload.domains ?? [],
    databaseName: payload.databaseName ?? `tenant_${payload.slug}`,
    databaseUri: payload.databaseUri,
    status: payload.status ?? "inactive",
    subscriptionStatus: payload.subscriptionStatus ?? "pending",
    subscriptionExpiresAt: payload.subscriptionExpiresAt,
    isDeleted: false,
  }),

  toQuery: (query: Partial<ITenant>) => ({
    ...(query.slug && { slug: query.slug }),
    ...(query.status && { status: query.status }),
    ...(query.subscriptionStatus && {
      subscriptionStatus: query.subscriptionStatus,
    }),
    ...(query._id && { _id: query._id }),
  }),

  toEntity: (model: any): ITenant =>
    new (ITenant as any)(
      model._id?.toString(),
      model.name,
      model.slug,
      model.subdomain,
      model.domains,
      model.databaseName,
      model.databaseUri,
      model.status,
      model.subscriptionStatus,
      model.subscriptionExpiresAt,
      model.isDeleted,
      model.createdAt,
      model.updatedAt,
    ),
};
