import mongoose, { Schema, Model } from "mongoose";

/**
 * Adds standard fields and common middleware to a schema.
 *
 * Features:
 *  - Auto-incremented ID (e.g., VE-0000001, WA-0000001)
 *  - Soft delete handling (`isDeleted`, `deletedAt`)
 *  - Timestamps
 */
export const withBaseSchema = (
  schema: Schema,
  options: {
    prefix: string; // e.g., "VE" or "WA"
  }
) => {
  // Standard fields
  schema.add({
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
  });

  // Auto-increment ID middleware
  schema.pre("save", async function (next) {
    const doc = this as any;
    const idField = `${options.prefix.toLowerCase()}Id`;

    if (!doc[idField]) {
      const Model = this.constructor as Model<any>;
      const last = await Model.findOne({}, {}, { sort: { createdAt: -1 } });

      if (last && last[idField]) {
        const lastNumber = parseInt(last[idField].split("-")[1]);
        const newNumber = (lastNumber + 1).toString().padStart(7, "0");
        doc[idField] = `${options.prefix}-${newNumber}`;
      } else {
        doc[idField] = `${options.prefix}-0000001`;
      }
    }

    next();
  });

  // Soft delete filters
  const softDeleteFilter = function (this: any) {
    this.where({ isDeleted: { $ne: true } });
  };

  schema.pre("find", softDeleteFilter);
  schema.pre("countDocuments", softDeleteFilter);
  schema.pre("aggregate", function (next) {
    if (this.pipeline) {
      this.pipeline().unshift({ $match: { isDeleted: { $ne: true } } });
    }
    next();
  });

  return schema;
};
