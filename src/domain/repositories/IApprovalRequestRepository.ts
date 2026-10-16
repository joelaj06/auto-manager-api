import type { ApprovalRequest, ApprovalStatus } from "../entities/ApprovalRequest.js";

export interface IApprovalRequestRepository {
  lockById(id: string): Promise<ApprovalRequest | null>;
  save(request: ApprovalRequest): Promise<void>;
  list(status: ApprovalStatus | null, limit: number): Promise<ApprovalRequest[]>;
}
