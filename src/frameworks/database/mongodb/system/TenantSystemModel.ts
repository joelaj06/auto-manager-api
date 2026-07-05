import mongoose, { Model } from "mongoose";
import { type ITenant } from "../../../../entities/Tenant";

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
