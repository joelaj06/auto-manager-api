import mongoose, { Schema, Document, ObjectId } from "mongoose";
import { IVehicle } from "../../../../entities/Vehicle";

const vehicleSchema: Schema = new Schema({
  vehicleId: {
    type: String,
    unique: true,
  },
  licensePlate: {
    type: String,
    required: true,
    unique: true,
  },
  make: {
    type: String,
    required: true,
  },
  model: {
    type: String,
    required: true,
  },
  year: {
    type: Number,
    required: true,
  },
  color: {
    type: String,
    required: true,
  },
  vin: {
    type: String,
    required: false,
  },
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Company",
    required: true,
  },
  status: {
    type: String,
    enum: ["available", "in-use", "under-maintenance"],
    default: "available",
  },
  image: String,
  currentDriverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Driver",
  },
  salesHistory: [
    {
      saleId: { type: String, required: false },
      amount: { type: Number, required: false },
      date: { type: Date, required: false },
    },
  ],
  maintenanceRecords: [
    {
      maintenanceId: { type: String, required: false },
      serviceType: { type: String, required: false },
      cost: { type: Number, required: false },
      date: { type: Date, required: false },
    },
  ],
  rentalStatus: {
    type: Boolean,
    default: false,
  },
  rentalHistory: [
    {
      rentalId: { type: String, required: false },
      renterName: { type: String, required: false },
      startDate: { type: Date, required: false },
      endDate: { type: Date, required: false },
      cost: { type: Number, required: false },
    },
  ],
  insuranceDetails: {
    provider: { type: String, required: false },
    policyNumber: { type: String, required: false },
    expiryDate: { type: Date, required: false },
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Company",
    required: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date },
});

vehicleSchema.pre("save", async function (next) {
  const vehicle = this as unknown as IVehicle;
  if (!vehicle.vehicleId) {
    const lastVehicle = await mongoose
      .model("Vehicle")
      .findOne({}, {}, { sort: { createdAt: -1 } });
    if (lastVehicle && lastVehicle.vehicleId) {
      const lastVehicleNumber = parseInt(lastVehicle.vehicleId.split("-")[1]);
      const newVehicleNumber = (lastVehicleNumber + 1)
        .toString()
        .padStart(7, "0");
      vehicle.vehicleId = `VE-${newVehicleNumber}`;
    } else {
      vehicle.vehicleId = "VE-0000001";
      // Default start value if no previous vehicles exist
    }
  }
  next();
});

// Apply the isDeleted filter
vehicleSchema.pre("find", function () {
  this.where({ isDeleted: { $ne: true } });
});
vehicleSchema.pre("countDocuments", function () {
  this.where({ isDeleted: { $ne: true } });
});
vehicleSchema.pre("aggregate", function (next) {
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

export const Vehicle = mongoose.model("Vehicle", vehicleSchema);

// Mapper for Vehicle
export const VehicleMapper = {
  /**
   * Convert the object with the Vehicle creation parameters to a format usable for creating a new Vehicle entry
   */
  toDtoCreation: (payload: IVehicle) => {
    return {
      vehicleId: payload.vehicleId,
      licensePlate: payload.licensePlate,
      make: payload.make,
      model: payload.model,
      year: payload.year,
      color: payload.color,
      vin: payload.vin,
      ownerId: new mongoose.SchemaTypes.ObjectId(payload.ownerId!), // Ensure ownerId is converted to ObjectId
      status: payload.status,
      currentDriverId: payload.currentDriverId
        ? new mongoose.SchemaTypes.ObjectId(payload.currentDriverId)
        : undefined, // Optional field
      salesHistory: payload.salesHistory,
      maintenanceRecords: payload.maintenanceRecords,
      rentalStatus: payload.rentalStatus,
      rentalHistory: payload.rentalHistory,
      insuranceDetails: payload.insuranceDetails,
      createdBy: new mongoose.SchemaTypes.ObjectId(
        payload.createdBy!.toString()
      ),
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
    };
  },

  /**
   * Transform the query object into a MongoDB-compatible query.
   */
  toQuery: (query: IVehicle) => {
    return {
      ...(query.vehicleId && { vehicleId: query.vehicleId }),
      ...(query.licensePlate && { licensePlate: query.licensePlate }),
      ...(query.make && { make: query.make }),
      ...(query.model && { model: query.model }),
      ...(query.year && { year: query.year }),
      ...(query.color && { color: query.color }),
      ...(query.vin && { vin: query.vin }),
      ...(query.ownerId && {
        ownerId: new mongoose.SchemaTypes.ObjectId(query.ownerId),
      }),
      ...(query.status && { status: query.status }),
      ...(query.currentDriverId && {
        currentDriverId: new mongoose.SchemaTypes.ObjectId(
          query.currentDriverId
        ),
      }),
      ...(query.createdBy && {
        createdBy: new mongoose.SchemaTypes.ObjectId(query.createdBy),
      }),
      ...(query.createdAt && { createdAt: query.createdAt }),
      ...(query.updatedAt && { updatedAt: query.updatedAt }),
    };
  },

  /**
   * Convert the MongoDB document (model) into an IVehicle entity.
   */
  toEntity: (model: any): IVehicle => {
    return new IVehicle(
      model._id?.toString(), // Optional _id, converted to string
      model.vehicleId,
      model.licensePlate,
      model.make,
      model.model,
      model.year,
      model.color,
      model.vin,
      model.ownerId?.toString(), // Convert ObjectId to string
      model.status,
      model.currentDriverId?.toString(), // Convert ObjectId to string
      model.salesHistory,
      model.maintenanceRecords,
      model.rentalStatus,
      model.rentalHistory,
      model.insuranceDetails,
      model.createdBy,
      model.createdAt,
      model.updatedAt,
      model.image
    );
  },
};
