import mongoose, { Schema } from "mongoose";
import { withBaseSchema } from "../utils/baseModel";
import { IWorkAndPayAgreement } from "../../../../entities/WorkAndPay";

const workAndPayAgreementSchema = withBaseSchema(
  new Schema({
    agreementId: { type: String, unique: true },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },

    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
    },
    vehicleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vehicle",
      required: true,
      unique: true,
    },
    vehicle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vehicle",
      required: true,
      unique: true,
    },
    driver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
    },
    originalVehiclePrice: { type: Number, required: true },
    totalSalePrice: { type: Number, required: true },
    installmentAmount: { type: Number, required: true },
    paymentFrequency: {
      type: String,
      enum: ["weekly", "monthly"],
      required: true,
    },
    durationYears: { type: Number, required: true },
    amountPaid: { type: Number, default: 0 },
    balanceDue: { type: Number, required: true },
    installmentsPaid: { type: Number, default: 0 },
    installmentsRemaining: { type: Number, required: true },
    status: {
      type: String,
      enum: ["Active", "Completed", "Defaulted", "Cancelled", "Ongoing"],
      default: "Active",
    },
    startDate: { type: Date, required: true },
    completionDate: { type: Date, default: null },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  }),
  { prefix: "WA", idFieldName: "agreementId" },
);

export const WorkAndPayAgreement = mongoose.model(
  "WorkAndPayAgreement",
  workAndPayAgreementSchema,
);

// ======================================================
// 🔹 Mapper Utility
// ======================================================
export const WorkAndPayAgreementMapper = {
  toDtoCreation: (payload: any) => {
    const dto: Record<string, any> = {};
    Object.keys(workAndPayAgreementSchema.obj).forEach((key) => {
      dto[key] = payload[key];
    });
    return dto;
  },
  toEntity: (doc: any) => {
    const entity: Record<string, any> = {};
    Object.keys(workAndPayAgreementSchema.obj).forEach((key) => {
      entity[key] = doc[key];
    });
    entity._id = doc._id?.toString();

    // ✅ explicitly map timestamps
    if (doc.createdAt) entity.createdAt = doc.createdAt;
    if (doc.updatedAt) entity.updatedAt = doc.updatedAt;
    return entity as IWorkAndPayAgreement;
  },
};
