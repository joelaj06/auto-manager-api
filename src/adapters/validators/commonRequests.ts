import { z } from "zod";

/** The query parameters of a paged list: numbered pages, which the response headers describe. */
export const pageParams = (maxSize = 100, defaultSize = 20) => ({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(maxSize).default(defaultSize),
});

export const paginationQuery = z.object(pageParams());

export type PaginationQuery = z.infer<typeof paginationQuery>;

/** Path parameter `:id` that must be a UUID. */
export const idParams = z.object({
  id: z.uuid(),
});
