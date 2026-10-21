import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  IObjectStorage,
  PresignedUpload,
  StoredObject,
} from "../../application/ports/IObjectStorage.js";
import type { FileVisibility } from "../../domain/files/FileKinds.js";

export type ObjectStorageConfig = Readonly<{
  /** S3 API endpoint used by the server (empty: AWS S3 for `region`). */
  endpoint: string | null;
  /** Endpoint written into pre-signed URLs, when clients reach storage at another address. */
  presignEndpoint: string | null;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style URLs (`host/bucket/key`), needed by most self-hosted S3 servers. */
  forcePathStyle: boolean;
  privateBucket: string;
  publicBucket: string;
  /** Base URL of public objects (a CDN in front of the public bucket, or the bucket itself). */
  publicBaseUrl: string;
}>;

const NOT_FOUND = new Set(["NotFound", "NoSuchKey", "NoSuchBucket"]);
const isNotFound = (error: unknown) =>
  error instanceof S3ServiceException &&
  (NOT_FOUND.has(error.name) || error.$metadata.httpStatusCode === 404);

/**
 * S3-compatible object storage (AWS S3, Cloudflare R2, RustFS, MinIO …). Two buckets: private
 * (signed URLs only) and public (anonymous read, fronted by a CDN).
 */
export class S3ObjectStorage implements IObjectStorage {
  private readonly client: S3Client;
  private readonly signer: S3Client;

  constructor(private readonly config: ObjectStorageConfig) {
    const client = (endpoint: string | null) =>
      new S3Client({
        region: config.region,
        ...(endpoint === null ? {} : { endpoint }),
        forcePathStyle: config.forcePathStyle,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        // Only checksum when an operation requires it (self-hosted servers vary).
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
    this.client = client(config.endpoint);
    this.signer = client(config.presignEndpoint ?? config.endpoint);
  }

  async presignUpload(params: {
    visibility: FileVisibility;
    key: string;
    contentType: string;
    sizeBytes: number;
    expiresInSeconds: number;
  }): Promise<PresignedUpload> {
    const url = await getSignedUrl(
      this.signer,
      new PutObjectCommand({
        Bucket: this.bucket(params.visibility),
        Key: params.key,
        ContentType: params.contentType,
        ContentLength: params.sizeBytes,
        ...(params.visibility === "public"
          ? { CacheControl: "public, max-age=31536000, immutable" }
          : {}),
      }),
      {
        expiresIn: params.expiresInSeconds,
        // The client must send exactly these headers; they are part of the signature.
        signableHeaders: new Set(["content-type", "content-length"]),
      },
    );
    return {
      method: "PUT",
      url,
      headers: {
        "Content-Type": params.contentType,
        ...(params.visibility === "public"
          ? { "Cache-Control": "public, max-age=31536000, immutable" }
          : {}),
      },
      expiresAt: new Date(Date.now() + params.expiresInSeconds * 1_000),
    };
  }

  presignDownload(params: {
    key: string;
    filename: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<string> {
    const ascii = params.filename.replace(/[^\x20-\x7e]/g, "_").replaceAll('"', "");
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.config.privateBucket,
        Key: params.key,
        ResponseContentType: params.contentType,
        ResponseContentDisposition: `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(params.filename)}`,
      }),
      { expiresIn: params.expiresInSeconds },
    );
  }

  publicUrl(key: string): string {
    return `${this.config.publicBaseUrl.replace(/\/$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  async stat(visibility: FileVisibility, key: string): Promise<StoredObject | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket(visibility), Key: key }),
      );
      return { sizeBytes: head.ContentLength ?? 0, contentType: head.ContentType ?? null };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async readStart(visibility: FileVisibility, key: string, bytes: number): Promise<Uint8Array> {
    const object = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket(visibility),
        Key: key,
        Range: `bytes=0-${bytes - 1}`,
      }),
    );
    return (await object.Body?.transformToByteArray()) ?? new Uint8Array();
  }

  async put(
    visibility: FileVisibility,
    key: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket(visibility),
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
      }),
    );
  }

  async read(visibility: FileVisibility, key: string): Promise<Uint8Array> {
    const object = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket(visibility), Key: key }),
    );
    return (await object.Body?.transformToByteArray()) ?? new Uint8Array();
  }

  async remove(visibility: FileVisibility, key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket(visibility), Key: key }),
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  /**
   * Creates both buckets if missing, makes the public one anonymously readable and allows
   * browser uploads from `origins` (CORS). Idempotent; used by `yarn storage:setup` and tests.
   */
  async setup(origins: readonly string[]): Promise<void> {
    for (const bucket of [this.config.privateBucket, this.config.publicBucket]) {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        if (!isNotFound(error)) throw error;
        await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
      }
      await this.client.send(
        new PutBucketCorsCommand({
          Bucket: bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: [...origins],
                AllowedMethods: ["PUT", "GET", "HEAD"],
                AllowedHeaders: ["content-type", "cache-control"],
                ExposeHeaders: ["etag"],
                MaxAgeSeconds: 3_600,
              },
            ],
          },
        }),
      );
    }
    await this.client.send(
      new PutBucketPolicyCommand({
        Bucket: this.config.publicBucket,
        Policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { AWS: ["*"] },
              Action: ["s3:GetObject"],
              Resource: [`arn:aws:s3:::${this.config.publicBucket}/*`],
            },
          ],
        }),
      }),
    );
  }

  destroy(): void {
    this.client.destroy();
    this.signer.destroy();
  }

  private bucket(visibility: FileVisibility): string {
    return visibility === "public" ? this.config.publicBucket : this.config.privateBucket;
  }
}
