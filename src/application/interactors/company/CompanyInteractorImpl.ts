import { inject, injectable } from "inversify";
import { ICompany } from "../../../entities";
import { ICompanyRepository } from "../../../frameworks";
import { INTERFACE_TYPE } from "../../../utils";
import { ICompanyInteractor } from "./ICompanyInteractor";
import {
  BadRequestError,
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
  async addCompany(data: ICompany): Promise<ICompany> {
    if (!data) throw new UnprocessableEntityError("Company data is required");
    const company = await this.repository.addCompay(data);
    if (!company) throw new BadRequestError("Error while adding company");
    return company;
  }
}
