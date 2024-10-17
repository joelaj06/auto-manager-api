import { injectable } from "inversify";
import { ICustomerRepository } from "./ICustomerRepository";
import {
  ICustomer,
  RequestQuery,
  PaginatedResponse,
} from "../../../../../entities";
import { Customer, CustomerMapper } from "../../models";

@injectable()
export class CustomerRepositoryImpl implements ICustomerRepository {
  async save(data: ICustomer): Promise<ICustomer> {
    try {
      if (!data) throw new Error("Customer data is required");
      const newCustomer = new Customer(data);
      await newCustomer.save();
      return CustomerMapper.toEntity(newCustomer);
    } catch (error) {
      throw error;
    }
  }
  async update(id: string, data: ICustomer): Promise<ICustomer> {
    try {
      if (!id) throw new Error("Customer id is required");
      if (!data) throw new Error("Customer data is required");

      const updatedCustomer = await Customer.findByIdAndUpdate(id, data, {
        new: true,
      });

      if (!updatedCustomer) throw new Error("Customer not found");

      return CustomerMapper.toEntity(updatedCustomer);
    } catch (error) {
      throw error;
    }
  }
  async delete(id: string): Promise<ICustomer> {
    try {
      if (!id) throw new Error("Customer id is required");
      const deletedCustomer = await Customer.findByIdAndDelete(id);
      if (!deletedCustomer) throw new Error("Customer not found");
      return CustomerMapper.toEntity(deletedCustomer);
    } catch (error) {
      throw error;
    }
  }
  async findAll(query: RequestQuery): Promise<PaginatedResponse<ICustomer>> {
    try {
      const { search, pageSize, status } = query;
      const searchQuery = search || "";
      const limit = pageSize || 10;
      const pageIndex = query.pageIndex || 1;
      const startIndex = (pageIndex - 1) * limit;
      let searchCriteria = {};

      if (searchQuery) {
        searchCriteria = {
          $or: [
            { name: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
            { customerCode: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
          ],
        };
      }

      if (status) {
        searchCriteria = {
          ...searchCriteria,
          status,
        };
      }

      const customers = await Customer.find(searchCriteria)
        .limit(limit)
        .skip(startIndex);

      const data: ICustomer[] = customers.map((customer) =>
        CustomerMapper.toEntity(customer)
      );

      const totalCount = await Customer.countDocuments(searchCriteria);

      const totalPages = Math.ceil(totalCount / limit);

      const paginatedRes: PaginatedResponse<ICustomer> = {
        data,
        totalPages,
        totalCount,
        pageCount: pageIndex,
      };

      return paginatedRes;
    } catch (error) {
      throw error;
    }
  }
  async findById(id: string): Promise<ICustomer | null | undefined> {
    if (!id) throw new Error("Customer id is required");
    const customer = await Customer.findById(id).populate("rentalHistory");
    if (!customer) return null;
    return CustomerMapper.toEntity(customer);
  }
}
