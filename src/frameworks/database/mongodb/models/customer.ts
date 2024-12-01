import mongoose, { Schema } from "mongoose";
import { ICustomer } from "../../../../entities";

const customerSchema: Schema = new Schema(
  {
    name: {
      type: String,
      required: true,
    },
    customerCode: {
      type: String,
      unique: true,
    },
    email: {
      type: String,
      unique: true,
    },
    phone: {
      type: String,
      required: true,
    },
    address: {
      type: String,
    },
    identificationNumber: {
      type: String,
    },
    occupation: {
      type: String,
    },
    business: {
      type: String,
    },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
    },
    dateOfBirth: {
      type: Date,
    },
    rentalHistory: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Rental",
      },
    ],
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
  },
  { timestamps: true }
);

//customer code
customerSchema.pre("save", async function (next) {
  const customer = this as ICustomer;

  if (!customer.customerCode) {
    const lastCustomer = await mongoose.model("Customer").findOne(
      {},
      {},
      {
        sort: { createdAt: -1 },
      }
    );

    if (lastCustomer && lastCustomer.customerCode) {
      const lastCustomerNumber = parseInt(
        lastCustomer.customerCode.split("-")[1]
      );
      const newCustomerCode = (lastCustomerNumber + 1)
        .toString()
        .padStart(7, "0");
      customer.customerCode = `CU-${newCustomerCode}`;
    } else {
      customer.customerCode = "CU-0000001"; // Default start value if no previous customers exist
    }
  }

  next();
});

// Apply the isDeleted filter
customerSchema.pre("find", function () {
  this.where({ isDeleted: { $ne: true } });
});
customerSchema.pre("countDocuments", function () {
  this.where({ isDeleted: { $ne: true } });
});
customerSchema.pre("aggregate", function (next) {
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

export const Customer = mongoose.model("Customer", customerSchema);

export const CustomerMapper = {
  /**
   * Convert the object with the Customer creation parameters to a format usable for creating a new Customer entry.
   */
  toDtoCreation: (payload: ICustomer) => {
    return {
      name: payload.name,
      customerCode: payload.customerCode,
      email: payload.email,
      phone: payload.phone,
      address: payload.address,
      identificationNumber: payload.identificationNumber,
      occupation: payload.occupation,
      business: payload.business,
      company: new mongoose.Types.ObjectId(payload.company as string), // Ensure company ID is an ObjectId
      dateOfBirth: payload.dateOfBirth,
      rentalHistory: payload.rentalHistory?.map(
        (rentalId) => new mongoose.Types.ObjectId(rentalId as string)
      ),
    };
  },

  /**
   * Transform the query object into a MongoDB-compatible query.
   */
  toQuery: (query: Partial<ICustomer>) => {
    return {
      ...(query.name && { name: query.name }),
      ...(query.customerCode && { customerCode: query.customerCode }),
      ...(query.email && { email: query.email }),
      ...(query.phone && { phone: query.phone }),
      ...(query.identificationNumber && {
        identificationNumber: query.identificationNumber,
      }),
      ...(query.occupation && { occupation: query.occupation }),
      ...(query.business && { business: query.business }),
      ...(query.company && {
        company: new mongoose.Types.ObjectId(query.company),
      }),
      ...(query.dateOfBirth && { dateOfBirth: query.dateOfBirth }),
      ...(query.rentalHistory && {
        rentalHistory: { $in: query.rentalHistory },
      }), // Search for rentals in history
    };
  },

  /**
   * Convert the MongoDB document (model) into a Customer entity.
   */
  toEntity: (model: any): ICustomer => {
    return new ICustomer(
      model._id?.toString(),
      model.name,
      model.customerCode,
      model.email,
      model.phone,
      model.address,
      model.company?.toString(), // Ensure company ID is converted to string
      model.business,
      model.occupation,
      model.identificationNumber,
      model.dateOfBirth,
      model.rentalHistory, // Reference to rental history (could be populated or IDs)
      model.createdAt,
      model.updatedAt
    );
  },
};
