import mongoose, { Document, Model, Schema } from "mongoose";
import { withBaseSchema } from "../utils/baseModel";
import { IPaymentRecord } from "../../../../entities/PaymentRecord";

export interface PaymentRecordDocument extends Document {
  paymentId?: string;
  workAndPayAgreementId: mongoose.Types.ObjectId;
  amount: number;
  paymentDate: Date;
  method: string;
  createdAt: Date;
  updatedAt: Date;
  isDeleted?: boolean;
  deletedAt?: Date | null;
}

const paymentSchema = new Schema<PaymentRecordDocument>({
  paymentId: { type: String, unique: true },
  workAndPayAgreementId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "WorkAndPayAgreement",
    required: true,
  },
  amount: { type: Number, required: true },
  paymentDate: { type: Date, default: Date.now },
  method: { type: String, required: true },
});

withBaseSchema(paymentSchema, { prefix: "PR", idFieldName: "paymentId" });

export const createPaymentRecordModel = (
  connection: mongoose.Connection | mongoose.Mongoose = mongoose,
): Model<any> => {
  const modelName = "PaymentRecord";
  const targetConnection =
    connection instanceof mongoose.Mongoose
      ? connection
      : (connection as mongoose.Connection);
  const existingModel = targetConnection.models[modelName];
  if (existingModel) return existingModel as Model<any>;
  return targetConnection.model(modelName, paymentSchema);
};

export const PaymentRecord = createPaymentRecordModel();

export const PaymentRecordMapper = {
  toDtoCreation: (payload: IPaymentRecord) => ({
    paymentId: payload.paymentId, // optional
    workAndPayAgreementId: new mongoose.Types.ObjectId(
      payload.workAndPayAgreementId,
    ),
    amount: payload.amount,
    paymentDate: payload.paymentDate
      ? new Date(payload.paymentDate)
      : new Date(),
    method: payload.method,
  }),
  toEntity: (doc: any): IPaymentRecord => ({
    _id: doc._id?.toString(),
    paymentId: doc.paymentId,
    workAndPayAgreementId: doc.workAndPayAgreementId?.toString(),
    amount: doc.amount,
    paymentDate: doc.paymentDate?.toISOString?.() ?? String(doc.paymentDate),
    method: doc.method,
  }),
};
