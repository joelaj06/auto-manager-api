import { InvalidSlugError, TenantSlug } from "./TenantSlug.js";

/**
 * Where a business lives on the web: `<slug>.<base domain>`, with the scheme and port of the web
 * app (http://alpha.localhost:5174 locally, https://alpha.example.com in production). It answers
 * both ways: the address of a slug for links, and the slug of a host name for requests.
 */
export class TenantAddressing {
  private readonly scheme: string;
  private readonly port: string;
  private readonly baseDomain: string;
  private readonly ownHosts: ReadonlySet<string>;

  constructor(
    settings: Readonly<{
      webAppUrl: string;
      baseDomain: string;
      /** Our own host names under the base domain (the API, the console): never a business. */
      ownHosts?: readonly string[];
    }>,
  ) {
    const web = new URL(settings.webAppUrl);
    this.scheme = web.protocol;
    this.port = web.port === "" ? "" : `:${web.port}`;
    this.baseDomain = settings.baseDomain.toLowerCase();
    this.ownHosts = new Set((settings.ownHosts ?? []).map((host) => host.toLowerCase()));
  }

  /** The CORS origin pattern covering every business's address. */
  static originPattern(webAppUrl: string, baseDomain: string): string {
    const web = new URL(webAppUrl);
    return `${web.protocol}//*.${baseDomain.toLowerCase()}${web.port === "" ? "" : `:${web.port}`}`;
  }

  /** A page of a business's web portal; `path` starts with a slash. */
  urlOf(slug: string, path: string): string {
    return `${this.scheme}//${slug}.${this.baseDomain}${this.port}${path}`;
  }

  /** The slug a host name spells, or null for anything else (the apex, `api.`, `a.b.`). */
  slugOfHost(hostname: string): string | null {
    const host = hostname.toLowerCase().replace(/\.$/, "");
    const suffix = `.${this.baseDomain}`;
    if (!host.endsWith(suffix) || this.ownHosts.has(host)) return null;
    try {
      return TenantSlug.parse(host.slice(0, -suffix.length)).value;
    } catch (error) {
      if (error instanceof InvalidSlugError) return null;
      throw error;
    }
  }
}
