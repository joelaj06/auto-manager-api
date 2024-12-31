import mongoose, { Schema } from "mongoose";
import { IRental, IRentalExtension } from "../../../../entities";

const rentalExtensionSchema: Schema = new Schema(
  {
    extendedBalance: { type: Number, required: false },
    extendedAmount: { type: Number, required: false },
    extendedDate: { type: Date, required: false },
    extendedNote: { type: String, required: false },
    extendedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
  },
  {
    timestamps: true,
  }
);

const rentalSchema: Schema = new Schema(
  {
    rentalCode: {
      type: String,
      unique: true,
    },
    renter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },
    vehicle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vehicle",
      required: true,
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    date: {
      type: Date,
      default: new Date(),
    },
    cost: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "completed", "canceled"],
      default: "active",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
    note: {
      type: String,
      required: false,
    },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    purpose: {
      type: String,
      required: false,
    },
    amountPaid: {
      type: Number,
      required: true,
    },
    balance: {
      type: Number,
      required: true,
    },
    totalAmount: {
      type: Number,
      required: true,
    },
    receiptNumber: {
      type: String,
      required: false,
    },
    dateReturned: {
      type: Date,
      required: false,
    },
    extensions: [rentalExtensionSchema],
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    
  },
  { timestamps: true }
);

rentalSchema.pre("save", async function (next) {
  const rental = this as IRental;

  if (!rental.rentalCode) {
    const lastRental = await mongoose
      .model("Rental")
      .findOne({}, {}, { sort: { createdAt: -1 } });

    if (lastRental && lastRental.rentalCode) {
      const lastRentalNumber = parseInt(lastRental.rentalCode.split("-")[1]);
      const newRentalCode = (lastRentalNumber + 1).toString().padStart(7, "0");
      rental.rentalCode = `RT-${newRentalCode}`;
    } else {
      rental.rentalCode = "RT-0000001"; // Default start value if no previous rentals exist
    }
  }

  next();
});

// Apply the isDeleted filter
rentalSchema.pre("find", function () {
  this.where({ isDeleted: { $ne: true } });
});
rentalSchema.pre("countDocuments", function () {
  this.where({ isDeleted: { $ne: true } });
});
rentalSchema.pre("aggregate", function (next) {
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

const Rental = mongoose.model("Rental", rentalSchema);

export default Rental;

export const RentalMapper = {
  /**
   * Convert the object with the Rental creation parameters to a format usable for creating a new Rental entry.
   */
  toDtoCreation: (payload: IRental) => {
    return {
      rentalCode: payload.rentalCode,
      renter: new mongoose.Types.ObjectId(payload.renter as string),
      vehicle: new mongoose.Types.ObjectId(payload.vehicle as string),
      startDate: payload.startDate,
      endDate: payload.endDate,
      cost: payload.cost,
      status: payload.status,
      createdBy: new mongoose.Types.ObjectId(payload.createdBy!),
      updatedBy: payload.updatedBy
        ? new mongoose.Types.ObjectId(payload.updatedBy)
        : undefined,
      note: payload.note,
      company: new mongoose.Types.ObjectId(payload.company!),
      purpose: payload.purpose,
      amountPaid: payload.amountPaid,
      balance: payload.balance,
      totalAmount: payload.totalAmount,
      receiptNumber: payload.receiptNumber,
      dateReturned: payload.dateReturned,
      extensions: payload.extensions?.map((extension) => ({
        extendedBalance: extension.extendedBalance,
        extendedAmount: extension.extendedAmount,
        extendedDate: extension.extendedDate,
        extendedNote: extension.extendedNote,
      })),
      date: payload.date || new Date(),
    };
  },

  /**
   * Convert the MongoDB document (model) into a Rental entity.
   */
  toEntity: (model: any): IRental => {
    return new IRental(
      model._id?.toString(),
      model.rentalCode,
      model.renter,
      model.vehicle,
      model.startDate,
      model.endDate,
      model.cost,
      model.status,
      model.createdBy,
      model.updatedBy,
      model.note,
      model.company,
      model.createdAt,
      model.updatedAt,
      model.purpose,
      model.amountPaid,
      model.balance,
      model.totalAmount,
      model.receiptNumber,
      model.dateReturned,
      model.extensions?.map((extension: IRentalExtension) => ({
        extendedBalance: extension.extendedBalance,
        extendedAmount: extension.extendedAmount,
        extendedDate: extension.extendedDate,
        extendedNote: extension.extendedNote,
        extendedBy: extension.extendedBy,
      })),
      model.date
    );
  },
};
