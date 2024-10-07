import { ICompany } from "../../../entities";

export interface ICompanyInteractor {
  addCompany(data: ICompany): Promise<ICompany>;
}
