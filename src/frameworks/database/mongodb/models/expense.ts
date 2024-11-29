import express from "express";
import mongoose, { Schema } from "mongoose";
import { IExpense, IExpenseCategory } from "../../../../entities/Expense";

const expenseSchema: Schema = new Schema(
  {
    expenseId: {
      type: String,
      unique: true,
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
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ExpenseCategory",
      required: true,
    },
    description: {
      type: String,
      required: false,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    incurredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    vehicle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vehicle",
    },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
  },
  { timestamps: true }
);
expenseSchema.pre("save", async function (next) {
  const expense = this as IExpense;

  if (!expense.expenseId) {
    const lastExpense = await mongoose
      .model("Expense")
      .findOne({}, {}, { sort: { createdAt: -1 } });

    if (lastExpense && lastExpense.expenseId) {
      const lastExpenseNumber = parseInt(lastExpense.expenseId.split("-")[1]);
      const newExpense = (lastExpenseNumber + 1).toString().padStart(7, "0");
      expense.expenseId = `EXP-${newExpense}`;
    } else {
      expense.expenseId = "EXP-0000001"; // Default start value if no previous expense exist
    }
  }

  next();
});

// Apply the isDeleted filter
expenseSchema.pre("find", function () {
  this.where({ isDeleted: { $ne: true } });
});
expenseSchema.pre("countDocuments", function () {
  this.where({ isDeleted: { $ne: true } });
});
expenseSchema.pre("aggregate", function (next) {
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


const Expense = mongoose.model("Expense", expenseSchema);

//expense category schema

const expenseCategorySchema: Schema = new Schema(
  {
    name: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

const ExpenseCategory = mongoose.model(
  "ExpenseCategory",
  expenseCategorySchema
);
export { Expense, ExpenseCategory };

// Expense Mapper
export const ExpenseMapper = {
  /**
   * Convert the object with the Expense creation parameters to a format usable for creating a new Expense entry
   */
  toDtoCreation: (payload: IExpense) => {
    return {
      category: payload.category,
      amount: payload.amount,
      description: payload.description,
      incurredBy: new mongoose.Schema.Types.ObjectId(
        payload.incurredBy!.toString()
      ), // Ensure user ID is converted to ObjectId
      vehicleId: payload.vehicle
        ? new mongoose.Schema.Types.ObjectId(payload.vehicle.toString())
        : undefined, // Convert if vehicleId exists
      date: payload.date,
    };
  },

  /**
   * Convert the MongoDB document (model) into an Expense entity.
   */
  toEntity: (model: any): IExpense => {
    return new IExpense(
      model._id?.toString(), // Convert ObjectId to string
      model.expenseId,
      model.category, // Convert ObjectId to string
      model.status,
      model.categoryId?.toString(), // Convert ObjectId to string
      model.company, // Convert ObjectId to string
      model.amount,
      model.description,
      model.incurredBy, // Convert ObjectId to string
      model.vehicle, // Convert ObjectId to string
      model.date,
      model.createdAt,
      model.updatedAt
    );
  },
};

// Expense category mapper
export const ExpenseCategoryMapper = {
  toEntity: (model: any): IExpenseCategory => {
    return new IExpenseCategory(
      model._id?.toString(), // Convert ObjectId to string
      model.name,
      model.description,
      model.createdBy,
      model.createdAt,
      model.updatedAt
    );
  },
};
