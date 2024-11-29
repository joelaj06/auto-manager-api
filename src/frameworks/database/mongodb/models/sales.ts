import mongoose, { Schema } from "mongoose";
import { ISale } from "../../../../entities";

const salesSchema: Schema = new Schema(
  {
    saleId: {
      type: String,
      // required: true,
      unique: true,
    },
    company: {
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
    driver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
    },
    vehicle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vehicle",
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "approved",
    },
    approvedOrRejectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // Can be either admin or driver
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
  },
  { timestamps: true }
);
// Add pre-save middleware to set the saleId
// If the saleId is not provided, generate a unique ID based on the last sale ID in the database.
// If no previous sales exist, use a default start value.

salesSchema.pre("save", async function (next) {
  const sale = this as ISale;

  if (!sale.saleId) {
    const lastSale = await mongoose
      .model("Sale")
      .findOne({}, {}, { sort: { createdAt: -1 } });

    if (lastSale && lastSale.saleId) {
      const lastSaleNumber = parseInt(lastSale.saleId.split("-")[1]);
      const newSaleNumber = (lastSaleNumber + 1).toString().padStart(7, "0");
      sale.saleId = `SL-${newSaleNumber}`;
    } else {
      sale.saleId = "SL-0000001"; // Default start value if no previous sales exist
    }
  }

  next();
});

// Apply the isDeleted filter
salesSchema.pre("find", function () {
  this.where({ isDeleted: { $ne: true } });
});
salesSchema.pre("countDocuments", function () {
  this.where({ isDeleted: { $ne: true } });
});
salesSchema.pre("aggregate", function (next) {
  // Ensure that the current aggregation pipeline exists
  if (!this.pipeline) {
    return next();
  }

  // Add a $match stage at the beginning of the pipeline
  this.pipeline().unshift({
    $match: { isDeleted: { $ne: true } },
  });

  next();
});

const Sale = mongoose.model("Sale", salesSchema);
export default Sale;

export const SalesMapper = {
  /**
   * Convert the object with the Sale creation parameters to a format usable for creating a new Sale entry.
   */
  toDtoCreation: (payload: ISale) => {
    return {
      driverId: new mongoose.Schema.Types.ObjectId(payload.driverId!),
      vehicleId: new mongoose.Schema.Types.ObjectId(payload.vehicleId!), // Ensure vehicle ID is converted to ObjectId
      amount: payload.amount,
      date: payload.date || new Date(),
      status: payload.status || "pending",
      createdBy: new mongoose.Schema.Types.ObjectId(payload.createdBy!),
      updatedBy: new mongoose.Schema.Types.ObjectId(payload.updatedBy!),
    };
  },

  /**
   * Transform the query object into a MongoDB-compatible query.
   */
  toQuery: (query: Partial<ISale>) => {
    return {
      ...(query.driverId && {
        driverId: new mongoose.Schema.Types.ObjectId(query.driverId),
      }),
      ...(query.vehicleId && {
        vehicleId: new mongoose.Schema.Types.ObjectId(query.vehicleId),
      }),
      ...(query.amount && { amount: query.amount }),
      ...(query.status && { status: query.status }),
      ...(query.date && { date: query.date }),
      ...(query.createdBy && {
        createdBy: new mongoose.Schema.Types.ObjectId(query.createdBy),
      }),
      ...(query.updatedBy && {
        updatedBy: new mongoose.Schema.Types.ObjectId(query.updatedBy),
      }),
    };
  },

  /**
   * Convert the MongoDB document (model) into a Sale entity.
   */
  toEntity: (model: any): ISale => {
    return new ISale(
      model._id?.toString(), // Convert ObjectId to string
      model.saleId,
      model.driverId?.toString(),
      model.vehicleId?.toString(),
      model.amount,
      model.date,
      model.company,
      model.status,
      model.createdBy?.toString(),
      model.updatedBy?.toString(),
      model.createdAt,
      model.updatedAt,
      model.driver, // Convert ObjectId to string
      model.vehicle,
      model.approvedOrRejectedBy
    );
  },
};
