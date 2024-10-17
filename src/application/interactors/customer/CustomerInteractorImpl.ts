import { inject, injectable } from "inversify";
import { ICustomer, RequestQuery, PaginatedResponse } from "../../../entities";
import { ICustomerRepository } from "../../../frameworks";
import { ICustomerInteractor } from "./ICustomerInteractor";
import { INTERFACE_TYPE } from "../../../utils";
import {
  BadRequestError,
  UnprocessableEntityError,
} from "../../../error_handler";

@injectable()
export class CustomerInteractorImpl implements ICustomerInteractor {
  private customerRepository: ICustomerRepository;

  constructor(
    @inject(INTERFACE_TYPE.CustomerRepositoryImpl)
    customerRepository: ICustomerRepository
  ) {
    this.customerRepository = customerRepository;
  }
  async saveCustomer(data: ICustomer): Promise<ICustomer> {
    if (!data) throw new UnprocessableEntityError("Customer data is required");
    const newCustomer = await this.customerRepository.save(data);

    if (!newCustomer) throw new BadRequestError("Customer not created");
    return newCustomer;
  }
  async updateCustomer(id: string, data: ICustomer): Promise<ICustomer> {
    if (!id) throw new UnprocessableEntityError("Customer id is required");
    if (!data) throw new UnprocessableEntityError("Customer data is required");
    const updatedCustomer = await this.customerRepository.update(id, data);
    if (!updatedCustomer)
      throw new BadRequestError("Error while updating Customer");
    return updatedCustomer;
  }
  async deleteCustomer(id: string): Promise<ICustomer> {
    if (!id) throw new UnprocessableEntityError("Customer id is required");
    const deletedCustomer = await this.customerRepository.delete(id);
    if (!deletedCustomer)
      throw new BadRequestError("Error while deleting Customer");
    return deletedCustomer;
  }
  async getAllCustomers(
    query: RequestQuery
  ): Promise<PaginatedResponse<ICustomer>> {
    return this.customerRepository.findAll(query);
  }
  async getACustomer(id: string): Promise<ICustomer> {
    if (!id) throw new UnprocessableEntityError("Customer id is required");
    const customer = await this.customerRepository.findById(id);
    if (!customer) throw new BadRequestError("Customer not found");
    return customer;
  }
}
