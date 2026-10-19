/** Where a file's record lives: the tenant's database or the platform database. */
export type FileScope = "tenant" | "platform";

/** Public files are served from the public bucket (and a CDN); private ones by signed URL. */
export type FileVisibility = "public" | "private";

export type FileKindPolicy = Readonly<{
  scope: FileScope;
  visibility: FileVisibility;
  contentTypes: readonly string[];
  maxBytes: number;
  description: string;
}>;

const MB = 1024 * 1024;
const IMAGES = ["image/png", "image/jpeg", "image/webp"] as const;
const DOCUMENTS = ["application/pdf", ...IMAGES] as const;

/**
 * What may be stored (docs/03 §12). SVG is never accepted: it can carry scripts. Modules add
 * kinds here as they need them (vehicle photos, receipts, contracts …).
 */
export const FILE_KINDS = Object.freeze({
  organisation_logo: {
    scope: "tenant",
    visibility: "public",
    contentTypes: IMAGES,
    maxBytes: 2 * MB,
    description: "Business logo (shown in the apps, receipts and the public tenant config)",
  },
  vehicle_photo: {
    scope: "tenant",
    visibility: "private",
    contentTypes: IMAGES,
    maxBytes: 10 * MB,
    description: "Photo of a vehicle (gallery; one is the primary photo)",
  },
  vehicle_document: {
    scope: "tenant",
    visibility: "private",
    contentTypes: DOCUMENTS,
    maxBytes: 10 * MB,
    description: "Scan or photo of a vehicle document (insurance, roadworthy …)",
  },
  party_document: {
    scope: "tenant",
    visibility: "private",
    contentTypes: DOCUMENTS,
    maxBytes: 10 * MB,
    description: "Identity or onboarding document of a driver, guarantor or customer",
  },
  application_document: {
    scope: "platform",
    visibility: "private",
    contentTypes: DOCUMENTS,
    maxBytes: 10 * MB,
    description: "KYC document attached to a tenant application",
  },
  partner_document: {
    scope: "platform",
    visibility: "private",
    contentTypes: DOCUMENTS,
    maxBytes: 10 * MB,
    description: "Reseller KYC document or signed agreement",
  },
} as const satisfies Record<string, FileKindPolicy>);

export type FileKind = keyof typeof FILE_KINDS;

export function isFileKind(value: unknown): value is FileKind {
  return typeof value === "string" && Object.hasOwn(FILE_KINDS, value);
}

export function fileKindPolicy(kind: FileKind): FileKindPolicy {
  return FILE_KINDS[kind];
}

/**
 * The real type of a file from its first bytes, for the types we accept (null: none of them).
 * Declared content types are never trusted on their own.
 */
export function sniffContentType(head: Uint8Array): string | null {
  const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50
  )
    return "image/webp";
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  return null;
}

/** Bytes needed by sniffContentType. */
export const SNIFF_BYTES = 16;

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export function extensionFor(contentType: string): string {
  return EXTENSIONS[contentType] ?? "bin";
}
