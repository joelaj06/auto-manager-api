import { inject, injectable } from "inversify";
import { ICompany, PaginatedResponse, RequestQuery } from "../../../entities";
import { ICompanyRepository } from "../../../frameworks";
import { INTERFACE_TYPE } from "../../../utils";
import { ICompanyInteractor } from "./ICompanyInteractor";
import {
  BadRequestError,
  NotFoundError,
  UnprocessableEntityError,
} from "../../../error_handler";

@injectable()
export class CompanyInteractorImpl implements ICompanyInteractor {
  private repository: ICompanyRepository;

  constructor(
    @inject(INTERFACE_TYPE.CompanyRepositoryImpl) repository: ICompanyRepository
  ) {
    this.repository = repository;
  }
  async updateCompany(id: string, data: ICompany): Promise<ICompany> {
    if (!id) throw new UnprocessableEntityError("Company id is required");
    const company = await this.repository.findCompanyById(id);
    if (!company) throw new NotFoundError("Company not found");
    const updatedCompany = await this.repository.updateCompany(id, data);
    if (!updatedCompany)
      throw new BadRequestError("Error while updating company");
    return updatedCompany;
  }

  async getACompany(id: string): Promise<ICompany> {
    if (!id) throw new UnprocessableEntityError("Company id is required");
    const company = await this.repository.findCompanyById(id);
    if (!company) throw new NotFoundError("Company not found");
    return company;
  }
  getAllCompanies(query: RequestQuery): Promise<PaginatedResponse<ICompany>> {
    return this.repository.findAllCompanies(query);
  }
  async addCompany(data: ICompany): Promise<ICompany> {
    if (!data) throw new UnprocessableEntityError("Company data is required");
    const company = await this.repository.addCompay(data);
    if (!company) throw new BadRequestError("Error while adding company");
    return company;
  }
}
