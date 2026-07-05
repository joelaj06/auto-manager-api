import mongoose from "mongoose";
import { createCompanyModel } from "../models/company";
import { createCustomerModel } from "../models/customer";
import { createDriverModel } from "../models/driver";
import { createExpenseModel } from "../models/expense";
import { createPermissionModel } from "../models/permission";
import { createRentalModel } from "../models/rental";
import { createRoleModel } from "../models/role";
import { createSaleModel } from "../models/sales";
import { createUserModel } from "../models/user";
import { createUserOTPModel } from "../models/userOTP";
import { createVehicleModel } from "../models/vehicle";
import { createWorkAndPayAgreementModel } from "../models/workandpay";
import { createPaymentRecordModel } from "../models/paymentRecord";

export const createTenantModels = (
  connection: mongoose.Connection | mongoose.Mongoose,
) => ({
  Company: createCompanyModel(connection),
  Customer: createCustomerModel(connection),
  Driver: createDriverModel(connection),
  Expense: createExpenseModel(connection),
  Permission: createPermissionModel(connection),
  Rental: createRentalModel(connection),
  Role: createRoleModel(connection),
  Sale: createSaleModel(connection),
  User: createUserModel(connection),
  UserOTP: createUserOTPModel(connection),
  Vehicle: createVehicleModel(connection),
  WorkAndPayAgreement: createWorkAndPayAgreementModel(connection),
  PaymentRecord: createPaymentRecordModel(connection),
});

export default createTenantModels;
