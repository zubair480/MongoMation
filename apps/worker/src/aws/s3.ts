// S3 run-artifact store. Mongo documents keep a small `artifact` reference ({bucket, key, bytes, sha256});
// the bytes live in S3 (SSE-S3, private bucket, lifecycle-expired - see infra/aws/mongomation.yaml).
import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Sender } from "./config.ts";

export interface ArtifactRef {
  bucket: string;
  key: string;
  bytes: number;
  sha256: string;
  contentType: string;
  uploadedAt: Date;
}

/** Keys are deterministic so a re-upload after a crash overwrites instead of duplicating. */
export function artifactKey(prefix: string, projectId: string | null, ...parts: string[]): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._~-]+/g, "_").slice(0, 120);
  return `${prefix}${projectId ? `projects/${safe(projectId)}/` : ""}${parts.map(safe).join("/")}`;
}

export async function putArtifact(
  s3: Sender,
  args: { bucket: string; key: string; body: string | Uint8Array; contentType: string; metadata?: Record<string, string> },
): Promise<ArtifactRef> {
  const body = typeof args.body === "string" ? Buffer.from(args.body, "utf8") : args.body;
  const sha256 = createHash("sha256").update(body).digest("hex");
  await s3.send(
    new PutObjectCommand({
      Bucket: args.bucket,
      Key: args.key,
      Body: body,
      ContentType: args.contentType,
      ServerSideEncryption: "AES256",
      ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
      Metadata: { project: "mongomation", ...args.metadata },
    }),
  );
  return { bucket: args.bucket, key: args.key, bytes: body.byteLength, sha256, contentType: args.contentType, uploadedAt: new Date() };
}

/** Short-lived GET URL for the dashboard (the bucket itself blocks all public access). */
export async function presignGet(s3: S3Client, bucket: string, key: string, ttlS: number): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttlS });
}
