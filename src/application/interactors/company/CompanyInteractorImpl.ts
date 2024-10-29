import { inject, injectable } from "inversify";
import {
  ICompany,
  IUser,
  PaginatedResponse,
  RequestQuery,
} from "../../../entities";
import { ICompanyRepository, IUserRepository } from "../../../frameworks";
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
  private userRepository: IUserRepository;

  constructor(
    @inject(INTERFACE_TYPE.CompanyRepositoryImpl)
    repository: ICompanyRepository,
    @inject(INTERFACE_TYPE.UserRepositoryImpl) userRepository: IUserRepository
  ) {
    this.repository = repository;
    this.userRepository = userRepository;
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
  async getAllCompanies(
    query: RequestQuery
  ): Promise<PaginatedResponse<ICompany>> {
    return await this.repository.findAllCompanies(query);
  }
  async addCompany(data: ICompany): Promise<ICompany> {
    if (!data) throw new UnprocessableEntityError("Company data is required");
    const company = await this.repository.addCompay(data);
    if (!company) throw new BadRequestError("Error while adding company");
    const userData: IUser = {
      company: company._id,
      companyId: company._id,
    };
    await this.userRepository.updateUser(data.ownerId!, userData);
    return company;
  }
}
