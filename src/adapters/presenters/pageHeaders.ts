import type { Page } from "../../application/dto/Page.js";

/** What a list response says about its page; CORS exposes them to browsers. */
export const PAGE_HEADERS = ["X-Total-Count", "X-Page", "X-Page-Size"] as const;

export function pageHeaders(page: Omit<Page<unknown>, "items">): Record<string, string> {
  return {
    "X-Total-Count": String(page.total),
    "X-Page": String(page.page),
    "X-Page-Size": String(page.pageSize),
  };
}
