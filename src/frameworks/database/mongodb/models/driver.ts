import mongoose, { Schema } from "mongoose";
import { IDriver } from "../../../../entities";

// Define the Driver Schema
const driverSchema: Schema = new Schema(
  {
    licenseNumber: {
      type: String,
    },
    lisenceExpiryDate: {
      type: Date,
    },
    status: {
      type: String,
      enum: ["available", "inactive", "suspended"], // You can define different statuses
      default: "available",
    },

    vehicleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vehicle",
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    vehicle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vehicle",
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    salesHistory: [
      {
        saleId: { type: String, required: true },
        amount: { type: Number, required: true },
        date: { type: Date, required: true },
      },
    ],
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Create the Driver model
const Driver = mongoose.model("Driver", driverSchema);
export default Driver;

export const DriverMapper = {
  /**
   * Convert the object with the Driver creation parameters to a format usable for creating a new Driver entry.
   */
  toDtoCreation: (payload: IDriver) => {
    return {
      licenseNumber: payload.licenseNumber,
      lisenceExpiryDate: payload.lisenceExpiryDate,
      status: payload.status,
      userId: new mongoose.Schema.Types.ObjectId(payload.userId!),
      vehicleId: new mongoose.Schema.Types.ObjectId(payload.vehicleId!), // Ensure vehicle ID is converted to ObjectId
      user: new mongoose.Schema.Types.ObjectId(payload.userId!),
      vehicle: new mongoose.Schema.Types.ObjectId(payload.vehicleId!), // Ensure vehicle ID is converted to ObjectId
      salesHistory: payload.salesHistory?.map((sale) => ({
        saleId: sale.saleId,
        amount: sale.amount,
        date: sale.date,
      })),
    };
  },

  /**
   * Transform the query object into a MongoDB-compatible query.
   */
  toQuery: (query: Partial<IDriver>) => {
    return {
      ...(query.licenseNumber && { licenseNumber: query.licenseNumber }),
      ...(query.lisenceExpiryDate && {
        lisenceExpiryDate: query.lisenceExpiryDate,
      }),
      ...(query.status && { status: query.status }),
      ...(query.vehicleId && {
        vehicleId: new mongoose.Schema.Types.ObjectId(query.vehicleId),
      }),
      ...(query.vehicle && {
        vehicle: new mongoose.Schema.Types.ObjectId(query.vehicle as string),
      }),
      ...(query.companyId && {
        companyId: new mongoose.Schema.Types.ObjectId(query.companyId),
      }),
      ...(query.user && {
        user: new mongoose.Schema.Types.ObjectId(query.user as string),
      }),
      ...(query.createdAt && { createdAt: query.createdAt }),
      ...(query.updatedAt && { updatedAt: query.updatedAt }),
      ...(query.salesHistory && { salesHistory: query.salesHistory }), // Adjust as needed for sales history
    };
  },

  /**
   * Convert the MongoDB document (model) into a Driver entity.
   */
  toEntity: (model: any): IDriver => {
    return new IDriver(
      model._id?.toString(), // Convert ObjectId to string
      model.licenseNumber,
      model.lisenceExpiryDate,
      model.status,
      model.vehicleId?.toString(),
      model.vehicle, // Convert ObjectId to string
      model.companyId?.toString(), // Convert ObjectId to string
      model.userId?.toString(),
      model.user, // Convert ObjectId to string
      model.salesHistory, // Adjust as needed to match your Driver class structure
      model.createdAt,
      model.updatedAt
    );
  },
};
