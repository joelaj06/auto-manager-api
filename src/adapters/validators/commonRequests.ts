import { z } from "zod";

/** Query parameters shared by every list endpoint (keyset pagination). */
export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuery>;

/** Path parameter `:id` that must be a UUID. */
export const idParams = z.object({
  id: z.uuid(),
});
