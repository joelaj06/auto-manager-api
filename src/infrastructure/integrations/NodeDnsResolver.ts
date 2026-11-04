import { promises as dns } from "node:dns";
import type { IDnsResolver } from "../../application/ports/ITenantDomains.js";

const NO_RECORD = new Set(["ENOTFOUND", "ENODATA"]);

/** No such name or record is an empty answer; a failing resolver is an error. */
async function records<T>(query: () => Promise<T[]>): Promise<T[]> {
  try {
    return await query();
  } catch (error) {
    if (NO_RECORD.has((error as NodeJS.ErrnoException).code ?? "")) return [];
    throw error;
  }
}

export class NodeDnsResolver implements IDnsResolver {
  async txt(name: string): Promise<string[]> {
    return (await records(() => dns.resolveTxt(name))).map((chunks) => chunks.join(""));
  }

  cnames(name: string): Promise<string[]> {
    return records(() => dns.resolveCname(name));
  }

  async addresses(name: string): Promise<string[]> {
    const [v4, v6] = await Promise.all([
      records(() => dns.resolve4(name)),
      records(() => dns.resolve6(name)),
    ]);
    return [...v4, ...v6];
  }
}
