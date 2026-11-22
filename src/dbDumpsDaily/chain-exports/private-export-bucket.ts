import {
  GetBucketPolicyStatusCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';

/**
 * The chain exports' private bucket, made once per account and region by
 * ops/chain-exports/chain-exports-bucket.yaml (an administrative step: the
 * deployment roles may not create buckets). It blocks all public access,
 * no CDN serves it, and its objects expire after 30 days.
 */
export const CHAIN_EXPORTS_BUCKET_PREFIX = '6529-chain-exports';

/** Presigned download links last this long, or less if the role's session ends first. */
export const PRESIGNED_URL_SECONDS = 6 * 60 * 60;

export class PrivateBucketError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'PrivateBucketError';
  }
}

/** The account id in a Lambda function ARN (arn:aws:lambda:region:account:function:name). */
export function accountIdFromFunctionArn(arn: string | undefined): string {
  const account = arn?.split(':')[4];
  if (!account || !/^\d{12}$/.test(account)) {
    throw new PrivateBucketError(
      'The function ARN carries no account id to name the export bucket'
    );
  }
  return account;
}

export function chainExportsBucketName(
  accountId: string,
  region: string
): string {
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) {
    throw new PrivateBucketError(`Not an AWS region: ${region}`);
  }
  return `${CHAIN_EXPORTS_BUCKET_PREFIX}-${accountId}-${region}`;
}

/** What the export checked about the bucket before writing. */
export interface BucketPrivacy {
  readonly bucket: string;
  readonly publicAccessBlocked: true;
  /** S3's own verdict on the bucket policy; false means not public. */
  readonly policyPublic: false;
}

/**
 * Refuses unless the bucket blocks every kind of public access and S3 says
 * its policy isn't public. The bucket's policy grants the function's role
 * these two reads.
 */
export async function assertBucketPrivate(
  s3: Pick<S3Client, 'send'>,
  bucket: string
): Promise<BucketPrivacy> {
  let block: Record<string, boolean | undefined> | undefined;
  try {
    const answer: any = await s3.send(
      new GetPublicAccessBlockCommand({ Bucket: bucket })
    );
    block = answer?.PublicAccessBlockConfiguration;
  } catch (error) {
    throw new PrivateBucketError(
      `Can't read the public access block of ${bucket}: ${(error as Error).message}`
    );
  }
  const blocked =
    block?.BlockPublicAcls === true &&
    block?.IgnorePublicAcls === true &&
    block?.BlockPublicPolicy === true &&
    block?.RestrictPublicBuckets === true;
  if (!blocked) {
    throw new PrivateBucketError(
      `${bucket} does not block all public access: the export is not written there`
    );
  }
  let isPublic: boolean | undefined;
  try {
    const status: any = await s3.send(
      new GetBucketPolicyStatusCommand({ Bucket: bucket })
    );
    isPublic = status?.PolicyStatus?.IsPublic;
  } catch (error) {
    throw new PrivateBucketError(
      `Can't read the policy status of ${bucket}: ${(error as Error).message}`
    );
  }
  if (isPublic !== false) {
    throw new PrivateBucketError(
      `S3 does not say ${bucket}'s policy is private: the export is not written there`
    );
  }
  return { bucket, publicAccessBlocked: true, policyPublic: false };
}

/** One object a run wrote. */
export interface PutResult {
  readonly key: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Writes objects under one run's prefix and counts them. */
export class PrivateExportWriter {
  private count = 0;
  private total = 0;

  constructor(
    private readonly s3: Pick<S3Client, 'send'>,
    readonly bucket: string,
    readonly prefix: string
  ) {}

  key(name: string): string {
    return `${this.prefix}${name}`;
  }

  async put(
    name: string,
    body: Buffer | string,
    contentType: string
  ): Promise<PutResult> {
    const key = this.key(name);
    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        ServerSideEncryption: 'AES256'
      })
    );
    this.count++;
    this.total += bytes.length;
    return { key, bytes: bytes.length, sha256 };
  }

  get files(): number {
    return this.count;
  }

  get bytes(): number {
    return this.total;
  }
}

export type Presigner = (
  bucket: string,
  key: string,
  seconds: number
) => Promise<string>;

export function s3Presigner(s3: S3Client): Presigner {
  return (bucket, key, seconds) =>
    getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: seconds
    });
}

/**
 * The stage a run's prefix names, from NODE_ENV as 6529.io sets it
 * (production, development), so a prefix says prod or staging plainly.
 */
export function exportStage(nodeEnv: string | undefined): string {
  const value = (nodeEnv ?? '').trim().toLowerCase();
  if (value === 'production') return 'prod';
  if (value === 'development') return 'staging';
  return value || 'unknown';
}

/**
 * A run's prefix: `<job>/<stage>/<UTC time>-<request id start>[-<scope>]/`.
 * A run of part of the export (one profile) names that part in its prefix.
 */
export function runPrefix(
  job: string,
  stage: string | undefined,
  startedAt: Date,
  requestId: string | undefined,
  scope: string | null = null
): string {
  const safeStage = (stage ?? 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  const time = startedAt.toISOString().replace(/[:.]/g, '-');
  const run = (requestId ?? 'local').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  const part = scope ? `-${scope.replace(/[^a-zA-Z0-9-]/g, '')}` : '';
  return `${job}/${safeStage || 'unknown'}/${time}-${run}${part}/`;
}

/**
 * When the run's presigned links stop working: after PRESIGNED_URL_SECONDS,
 * or earlier when the credentials that signed them expire first.
 */
export function linksExpireAt(
  now: Date,
  credentialsExpireAt: Date | null
): { readonly at: Date; readonly limitedByCredentials: boolean } {
  const byLife = new Date(now.getTime() + PRESIGNED_URL_SECONDS * 1000);
  if (credentialsExpireAt && credentialsExpireAt < byLife) {
    return { at: credentialsExpireAt, limitedByCredentials: true };
  }
  return { at: byLife, limitedByCredentials: false };
}

/** The signing credentials' expiry, when the SDK knows it. */
export async function credentialsExpiry(s3: S3Client): Promise<Date | null> {
  try {
    const credentials = await s3.config.credentials();
    return credentials.expiration ?? null;
  } catch {
    return null;
  }
}
