import { ICompany } from "../../../../../entities/Company";

export interface ICompanyRepository {
  addCompay(data: ICompany): Promise<ICompany>;
}
