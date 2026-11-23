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
 *
 * Its name is predictable, so every call names the function's own account
 * as the bucket's expected owner: a bucket of that name made in another
 * account is refused by S3 instead of being written to.
 */
export const CHAIN_EXPORTS_BUCKET_PREFIX = '6529-chain-exports';

/**
 * Presigned download links are signed for this long. They can stop sooner:
 * a link lasts no longer than the credentials that signed it. A fresh set
 * comes from the export's links job.
 */
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

/** The export bucket and the account that must own it. */
export interface ExportBucket {
  readonly name: string;
  /** The function's own account: S3 refuses a bucket another account owns. */
  readonly owner: string;
}

/** The export bucket for a function, from its ARN and region. */
export function exportBucketOf(
  functionArn: string | undefined,
  region: string
): ExportBucket {
  const owner = accountIdFromFunctionArn(functionArn);
  return { name: chainExportsBucketName(owner, region), owner };
}

/** What the export checked about the bucket before writing. */
export interface BucketPrivacy {
  readonly bucket: string;
  /** The account S3 confirmed owns the bucket. */
  readonly owner: string;
  readonly publicAccessBlocked: true;
  /** S3's own verdict on the bucket policy; false means not public. */
  readonly policyPublic: false;
}

/**
 * A network-level failure (a DNS lookup, a reset connection, a TLS
 * handshake): its message can name the host. Node's other ERR_ codes are
 * programming errors, not network errors.
 */
export function isNetworkError(error: unknown): boolean {
  const { code, syscall, hostname, host } = (error ?? {}) as {
    code?: unknown;
    syscall?: unknown;
    hostname?: unknown;
    host?: unknown;
  };
  return (
    syscall !== undefined ||
    hostname !== undefined ||
    host !== undefined ||
    (typeof code === 'string' &&
      /^(E(?!RR_)[A-Z0-9_]+|ERR_TLS_[A-Z0-9_]+)$/.test(code))
  );
}

/**
 * An S3 service error as its name and HTTP status, e.g. `AccessDenied
 * (403)`: never its message. A network error is rethrown as it is, for the
 * job to report by its code without the host.
 */
function s3Refusal(error: unknown): string {
  if (isNetworkError(error)) throw error;
  const { name, $metadata } = (error ?? {}) as {
    name?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  const status = $metadata?.httpStatusCode;
  return `${String(name ?? 'Error')}${status === undefined ? '' : ` (${status})`}`;
}

/**
 * Refuses unless the bucket is the function's own account's, blocks every
 * kind of public access, and S3 says its policy isn't public. The bucket's
 * policy grants the function's role these two reads.
 */
export async function assertBucketPrivate(
  s3: Pick<S3Client, 'send'>,
  bucket: ExportBucket
): Promise<BucketPrivacy> {
  let block: Record<string, boolean | undefined> | undefined;
  try {
    const answer: any = await s3.send(
      new GetPublicAccessBlockCommand({
        Bucket: bucket.name,
        ExpectedBucketOwner: bucket.owner
      })
    );
    block = answer?.PublicAccessBlockConfiguration;
  } catch (error) {
    throw new PrivateBucketError(
      `Can't read the public access block of ${bucket.name} as its owner's: ${s3Refusal(error)}`
    );
  }
  const blocked =
    block?.BlockPublicAcls === true &&
    block?.IgnorePublicAcls === true &&
    block?.BlockPublicPolicy === true &&
    block?.RestrictPublicBuckets === true;
  if (!blocked) {
    throw new PrivateBucketError(
      `${bucket.name} does not block all public access: the export is not written there`
    );
  }
  let isPublic: boolean | undefined;
  try {
    const status: any = await s3.send(
      new GetBucketPolicyStatusCommand({
        Bucket: bucket.name,
        ExpectedBucketOwner: bucket.owner
      })
    );
    isPublic = status?.PolicyStatus?.IsPublic;
  } catch (error) {
    throw new PrivateBucketError(
      `Can't read the policy status of ${bucket.name}: ${s3Refusal(error)}`
    );
  }
  if (isPublic !== false) {
    throw new PrivateBucketError(
      `S3 does not say ${bucket.name}'s policy is private: the export is not written there`
    );
  }
  return {
    bucket: bucket.name,
    owner: bucket.owner,
    publicAccessBlocked: true,
    policyPublic: false
  };
}

/** One object a run wrote. */
export interface PutResult {
  readonly key: string;
  readonly bytes: number;
  /** Hex SHA-256 of the bytes stored; S3 checked it on upload. */
  readonly sha256: string;
}

/**
 * A conditional write S3 refused: the object was already there (412), or
 * another conditional write to it was in flight (409).
 */
export function isWriteConflict(error: unknown): boolean {
  const { name, $metadata } = (error ?? {}) as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    name === 'PreconditionFailed' ||
    name === 'ConditionalRequestConflict' ||
    $metadata?.httpStatusCode === 412 ||
    $metadata?.httpStatusCode === 409
  );
}

/** What reading an object found. */
export type ReadResult =
  | { readonly found: true; readonly text: string }
  | { readonly found: false; readonly reason: 'missing' | 'forbidden' };

/** Writes and reads objects under one run's prefix, and counts what it wrote. */
export class PrivateExportWriter {
  private count = 0;
  private total = 0;

  constructor(
    private readonly s3: Pick<S3Client, 'send'>,
    readonly bucket: ExportBucket,
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
    return await this.putKey(this.key(name), body, contentType, true);
  }

  /**
   * Writes a key outside the run's prefix (a pointer to the run). With
   * `onlyIfAbsent`, S3 refuses to replace an object already there (see
   * isWriteConflict).
   */
  async putOutside(
    key: string,
    body: string,
    contentType: string,
    options: { readonly onlyIfAbsent?: boolean } = {}
  ): Promise<PutResult> {
    return await this.putKey(
      key,
      body,
      contentType,
      false,
      options.onlyIfAbsent ?? false
    );
  }

  private async putKey(
    key: string,
    body: Buffer | string,
    contentType: string,
    counted: boolean,
    onlyIfAbsent = false
  ): Promise<PutResult> {
    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    const digest = createHash('sha256').update(bytes).digest();
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket.name,
        ExpectedBucketOwner: this.bucket.owner,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
        // S3 refuses the upload if the bytes it got hash differently.
        ChecksumSHA256: digest.toString('base64'),
        ...(onlyIfAbsent ? { IfNoneMatch: '*' } : {})
      })
    );
    if (counted) {
      this.count++;
      this.total += bytes.length;
    }
    return { key, bytes: bytes.length, sha256: digest.toString('hex') };
  }

  /**
   * Reads a text object of the run. A key that doesn't exist reads as
   * missing; without list access S3 answers 403 for it, read as forbidden.
   */
  async read(name: string): Promise<ReadResult> {
    return await this.readKey(this.key(name));
  }

  /** Reads a key outside the run's prefix (a pointer to a run). */
  async readOutside(key: string): Promise<ReadResult> {
    return await this.readKey(key);
  }

  private async readKey(key: string): Promise<ReadResult> {
    try {
      const answer: any = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket.name,
          ExpectedBucketOwner: this.bucket.owner,
          Key: key
        })
      );
      return { found: true, text: await answer.Body.transformToString('utf8') };
    } catch (error) {
      const { name: code, $metadata } = (error ?? {}) as {
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };
      if (code === 'NoSuchKey' || code === 'NotFound') {
        return { found: false, reason: 'missing' };
      }
      if (code === 'AccessDenied' || $metadata?.httpStatusCode === 403) {
        return { found: false, reason: 'forbidden' };
      }
      throw error;
    }
  }

  get files(): number {
    return this.count;
  }

  get bytes(): number {
    return this.total;
  }
}

export type Presigner = (
  bucket: ExportBucket,
  key: string,
  seconds: number
) => Promise<string>;

/**
 * Presigned GETs that also name the expected owner. The SDK carries it in
 * the link's query, so a download needs nothing but the link.
 */
export function s3Presigner(s3: S3Client): Presigner {
  return (bucket, key, seconds) =>
    getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: bucket.name,
        Key: key,
        ExpectedBucketOwner: bucket.owner
      }),
      { expiresIn: seconds }
    );
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
 * A rehearsal or a run of part of the export (one profile) names that in
 * its prefix.
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

/** The latest the run's links can last: they may end sooner (see above). */
export function linksLastAtMost(now: Date): Date {
  return new Date(now.getTime() + PRESIGNED_URL_SECONDS * 1000);
}
