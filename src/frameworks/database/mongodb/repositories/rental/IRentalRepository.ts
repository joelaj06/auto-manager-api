import {
  IRental,
  PaginatedResponse,
  RequestQuery,
} from "../../../../../entities";

export interface IRentalRepository {
  findAll(query: RequestQuery): Promise<PaginatedResponse<IRental>>;
  findById(id: string): Promise<IRental | null | undefined>;
  save(data: IRental): Promise<IRental>;
  update(id: string, data: IRental): Promise<IRental>;
  delete(id: string): Promise<IRental>;
}
