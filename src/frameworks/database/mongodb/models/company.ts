import mongoose, { Schema, Document } from "mongoose";
import { IAddress, ICompany } from "../../../../entities/Company";

// Address Schema
const AddressSchema: Schema = new Schema({
  street: { type: String, required: false },
  city: { type: String, required: false },
  state: { type: String, required: false },
  postalCode: { type: String, required: false },
  country: { type: String, required: false },
});

// Company Schema
const companySchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    companyCode: { type: String, unique: true },
    industry: { type: String, required: false },
    phone: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    website: { type: String, required: false },
    registrationNumber: { type: String, required: false },
    taxIdentificationNumber: { type: String, required: false },
    companyType: { type: String, required: false },
    isActive: { type: Boolean, default: true },
    isVerified: { type: Boolean, default: false },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    employeesCount: { type: Number, default: 0 },
    logoUrl: { type: String, required: false },
    description: { type: String, required: false },
    subscriptionPlan: {
      type: String,
      enum: ["basic", "premium", "enterprise"],
      default: "basic",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      // required: true,
    },
    address: { type: AddressSchema, required: false },
  },
  {
    timestamps: true, // Automatically adds createdAt and updatedAt fields
  }
);

// Pre-save hook to generate companyCode
companySchema.pre("save", async function (next) {
  const company = this as ICompany;

  if (!company.companyCode) {
    const lastCompany = await mongoose
      .model("Company")
      .findOne({}, {}, { sort: { createdAt: -1 } });

    if (lastCompany && lastCompany.companyCode) {
      const lastCompanyCode = parseInt(lastCompany.companyCode.split("-")[1]);
      const newCompanyCode = (lastCompanyCode + 1).toString().padStart(7, "0");
      company.companyCode = `CO-${newCompanyCode}`;
    } else {
      company.companyCode = "CO-0000001"; // Default start value if no previous companies exist
    }
  }

  next();
});

// Export Company Model
const Company = mongoose.model("Company", companySchema);
export default Company;

export const CompanyMapper = {
  /**
   * Convert the object with the Company creation parameters to a format usable for creating a new Company entry.
   * This ensures fields like `ownerId` and `createdBy` are stored as ObjectId.
   */
  toDtoCreation: (payload: ICompany) => {
    return {
      name: payload.name,
      industry: payload.industry,
      phone: payload.phone,
      email: payload.email,
      website: payload.website,
      registrationNumber: payload.registrationNumber,
      taxIdentificationNumber: payload.taxIdentificationNumber,
      companyType: payload.companyType,
      isActive: payload.isActive,
      isVerified: payload.isVerified,
      ownerId: new mongoose.SchemaTypes.ObjectId(payload.ownerId ?? ""), // Ensure ownerId is converted to ObjectId
      employeesCount: payload.employeesCount,
      logoUrl: payload.logoUrl,
      description: payload.description,
      subscriptionPlan: payload.subscriptionPlan,
      createdBy: new mongoose.SchemaTypes.ObjectId(payload.createdBy ?? ""), // Ensure createdBy is converted to ObjectId
      address: CompanyMapper.toAddressDto(payload.address ?? {}),
    };
  },

  /**
   * Transform the query object into a MongoDB-compatible query.
   * It dynamically adds filters based on the fields provided.
   */
  toQuery: (query: Partial<ICompany>) => {
    return {
      ...(query.name && { name: query.name }),
      ...(query.industry && { industry: query.industry }),
      ...(query.phone && { phone: query.phone }),
      ...(query.email && { email: query.email }),
      ...(query.website && { website: query.website }),
      ...(query.companyType && { companyType: query.companyType }),
      ...(query.isActive !== undefined && { isActive: query.isActive }),
      ...(query.isVerified !== undefined && { isVerified: query.isVerified }),
      ...(query.ownerId && {
        ownerId: new mongoose.SchemaTypes.ObjectId(query.ownerId),
      }),
      ...(query.createdBy && {
        createdBy: new mongoose.SchemaTypes.ObjectId(query.createdBy),
      }),
      ...(query._id && { _id: new mongoose.SchemaTypes.ObjectId(query._id) }),
    };
  },

  /**
   * Convert the MongoDB document (model) into an ICompany entity.
   * Converts fields like ObjectId and optional fields to a more suitable format.
   */
  toEntity: (model: any): ICompany => {
    return new ICompany(
      model._id?.toString(), // Convert ObjectId to string
      model.name,
      model.companyCode,
      model.industry,
      model.phone,
      model.email,
      model.website,
      model.registrationNumber,
      model.taxIdentificationNumber,
      model.companyType,
      model.isActive,
      model.isVerified,
      model.ownerId?.toString(), // Convert ObjectId to string
      model.employeesCount,
      model.logoUrl,
      model.description,
      model.subscriptionPlan,
      model.createdAt,
      model.updatedAt,
      model.createdBy?.toString(), // Convert ObjectId to string
      CompanyMapper.toAddressEntity(model.address)
    );
  },

  /**
   * Convert the address object from IAddress entity to a format usable for creating/updating a Company entry.
   */
  toAddressDto: (payload: IAddress) => {
    return {
      street: payload.street,
      city: payload.city,
      state: payload.state,
      postalCode: payload.postalCode,
      country: payload.country,
    };
  },

  /**
   * Convert the MongoDB document (model) into an IAddress entity.
   * Converts fields like ObjectId to a more suitable format.
   */
  toAddressEntity: (model: any): IAddress => {
    return new IAddress(
      model.street,
      model.city,
      model.state,
      model.postalCode,
      model.country
    );
  },
};
