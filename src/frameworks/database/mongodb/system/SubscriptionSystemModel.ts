import mongoose, { Model } from "mongoose";
import { ISubscription } from "../../../../entities/Subscription";

const subscriptionSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    plan: {
      type: String,
      enum: ["basic", "premium", "enterprise"],
      default: "basic",
    },
    status: {
      type: String,
      enum: ["trialing", "active", "past_due", "canceled"],
      default: "trialing",
    },
    startDate: { type: Date, default: Date.now },
    currentPeriodEnd: { type: Date, required: true },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    externalProviderId: { type: String, required: false },
  },
  { timestamps: true },
);

export const createSubscriptionSystemModel = (
  connection: mongoose.Connection | mongoose.Mongoose = mongoose,
): Model<ISubscription & mongoose.Document> => {
  const modelName = "Subscription";
  const targetConnection =
    connection instanceof mongoose.Mongoose
      ? connection
      : (connection as mongoose.Connection);
  const existing = targetConnection.models[modelName];
  if (existing) return existing as Model<ISubscription & mongoose.Document>;
  return targetConnection.model<
    ISubscription & mongoose.Document,
    Model<ISubscription & mongoose.Document>
  >(modelName, subscriptionSchema);
};

const SubscriptionSystemModel = createSubscriptionSystemModel();
export default SubscriptionSystemModel;
