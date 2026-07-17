import mongoose, { Model } from "mongoose";
import { IAuditLog } from "../../../../entities/AuditLog";

const auditLogSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      required: false,
      index: true,
    },
    action: { type: String, required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, required: false },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const createAuditLogSystemModel = (
  connection: mongoose.Connection | mongoose.Mongoose = mongoose,
): Model<IAuditLog & mongoose.Document> => {
  const modelName = "AuditLog";
  const targetConnection =
    connection instanceof mongoose.Mongoose
      ? connection
      : (connection as mongoose.Connection);
  const existing = targetConnection.models[modelName];
  if (existing) return existing as Model<IAuditLog & mongoose.Document>;
  return targetConnection.model<
    IAuditLog & mongoose.Document,
    Model<IAuditLog & mongoose.Document>
  >(modelName, auditLogSchema);
  
};
const AuditLogSystemModel = createAuditLogSystemModel();
export default AuditLogSystemModel;
