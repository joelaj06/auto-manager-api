import type { Customer } from "../parties/Customer.js";
import type { Driver } from "../parties/Driver.js";
import type { Supplier } from "../parties/Supplier.js";

/** Drivers of the current tenant (tenant unit of work); removed drivers are never returned. */
export interface IDriverRepository {
  findById(id: string): Promise<Driver | null>;
  lockById(id: string): Promise<Driver | null>;
  save(driver: Driver): Promise<void>;
  /** Another driver (not removed) already uses this value. */
  phoneTaken(phone: string, exceptId: string | null): Promise<boolean>;
  ghanaCardTaken(number: string, exceptId: string | null): Promise<boolean>;
  licenceTaken(number: string, exceptId: string | null): Promise<boolean>;
}

/** Customers of the current tenant (tenant unit of work); removed customers are never returned. */
export interface ICustomerRepository {
  findById(id: string): Promise<Customer | null>;
  lockById(id: string): Promise<Customer | null>;
  save(customer: Customer): Promise<void>;
  emailTaken(email: string, exceptId: string | null): Promise<boolean>;
  ghanaCardTaken(number: string, exceptId: string | null): Promise<boolean>;
}

/** Suppliers of the current tenant (tenant unit of work); removed suppliers are never returned. */
export interface ISupplierRepository {
  findById(id: string): Promise<Supplier | null>;
  lockById(id: string): Promise<Supplier | null>;
  save(supplier: Supplier): Promise<void>;
  nameTaken(name: string, exceptId: string | null): Promise<boolean>;
}
