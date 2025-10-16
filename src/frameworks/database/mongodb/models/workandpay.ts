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
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
    },
    vehicleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vehicle",
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
      enum: ["Active", "Completed", "Defaulted"],
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
  { prefix: "WA" }
);

export const WorkAndPayAgreement = mongoose.model(
  "WorkAndPayAgreement",
  workAndPayAgreementSchema
);

// ======================================================
// 🔹 Mapper Utility
// ======================================================
export const WorkAndPayAgreementMapper = {
  toDtoCreation: (payload: IWorkAndPayAgreement) => ({
    agreementId: payload.id,
    ownerId: new mongoose.SchemaTypes.ObjectId(payload.ownerId),
    driverId: new mongoose.SchemaTypes.ObjectId(payload.driverId),
    vehicleId: new mongoose.SchemaTypes.ObjectId(payload.vehicleId),
    originalVehiclePrice: payload.originalVehiclePrice,
    totalSalePrice: payload.totalSalePrice,
    installmentAmount: payload.installmentAmount,
    paymentFrequency: payload.paymentFrequency,
    durationYears: payload.durationYears,
    amountPaid: payload.amountPaid,
    balanceDue: payload.balanceDue,
    installmentsPaid: payload.installmentsPaid,
    installmentsRemaining: payload.installmentsRemaining,
    status: payload.status,
    startDate: payload.startDate,
    completionDate: payload.completionDate,
    createdBy: new mongoose.SchemaTypes.ObjectId(payload.ownerId),
    createdAt: new Date(),
    updatedAt: new Date(),
  }),

  toQuery: (query: Partial<IWorkAndPayAgreement>) => ({
    ...(query.id && { agreementId: query.id }),
    ...(query.ownerId && {
      ownerId: new mongoose.SchemaTypes.ObjectId(query.ownerId),
    }),
    ...(query.driverId && {
      driverId: new mongoose.SchemaTypes.ObjectId(query.driverId),
    }),
    ...(query.vehicleId && {
      vehicleId: new mongoose.SchemaTypes.ObjectId(query.vehicleId),
    }),
    ...(query.status && { status: query.status }),
    ...(query.paymentFrequency && { paymentFrequency: query.paymentFrequency }),
  }),

  toEntity: (model: any): IWorkAndPayAgreement =>
    new IWorkAndPayAgreement(
      model._id?.toString(),
      model.ownerId?.toString(),
      model.driverId?.toString(),
      model.vehicleId?.toString(),
      model.originalVehiclePrice,
      model.totalSalePrice,
      model.installmentAmount,
      model.paymentFrequency,
      model.durationYears,
      model.amountPaid,
      model.balanceDue,
      model.installmentsPaid,
      model.installmentsRemaining,
      model.status,
      model.startDate,
      model.completionDate
    ),
};
