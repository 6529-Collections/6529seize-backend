import { createHash } from 'node:crypto';
import { z } from 'zod';
import { arweaveFileUploader, type ArweaveUploadState } from '@/arweave';
import { BadRequestException } from '@/exceptions';
import type { MintingClaimRow } from '@/api/minting-claims/api.minting-claims.db';
import type {
  ClaimFilePublisher,
  ClaimMediaUploadKind
} from '@/minting-claims/claims-media-arweave-upload';

const hash = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uploaderStateSchema = z.object({
  transaction: z
    .record(z.unknown())
    .and(z.object({ id: z.string().regex(/^[\w-]{43}$/) })),
  data_base64: z.literal(''),
  chunkIndex: z.number().int().min(0).max(10000),
  txPosted: z.boolean(),
  lastRequestTimeEnd: z.number().finite(),
  lastResponseStatus: z.number().finite(),
  lastResponseError: z.string().max(256)
});
const artifactSchema = z.object({
  source: z.string().max(2048),
  sha256: digest,
  bytes: z.number().int().min(0).max(250000000),
  contentType: z.string().max(255),
  upload: uploaderStateSchema.optional(),
  metadataBytes: z.string().max(1000000).optional()
});
const recoverySchema = z.object({
  version: z.literal(1),
  inputHash: digest,
  startedAt: z.number().finite(),
  failures: z.number().int().min(0),
  attempts: z.number().int().min(0),
  progress: z.number().int().min(0),
  attemptStartProgress: z.number().int().min(0),
  attemptActive: z.boolean(),
  status: z.enum(['uploading', 'failed']),
  failure: z.string().max(100).optional(),
  newRequest: z.boolean().optional(),
  files: z.object({
    image: artifactSchema.optional(),
    animation: artifactSchema.optional(),
    metadata: artifactSchema.optional()
  })
});
export type ClaimUploadRecoveryState = z.infer<typeof recoverySchema>;
export const CLAIM_UPLOAD_MAX_FAILURES = 10;
export const CLAIM_UPLOAD_MAX_ATTEMPTS = 128;
const MAX_RECOVERY_AGE_MS = 24 * 60 * 60 * 1000;

export class ClaimUploadYieldError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, ClaimUploadYieldError.prototype);
    this.name = 'ClaimUploadYieldError';
  }
}

export function claimUploadInputHash(claim: MintingClaimRow): string {
  return hash(
    JSON.stringify([
      claim.claim_id,
      claim.image_url,
      claim.animation_url,
      claim.image_details,
      claim.animation_details,
      claim.name,
      claim.description,
      claim.external_url,
      claim.attributes,
      claim.edition_size
    ])
  );
}

export function restoreClaimUploadState(
  raw: unknown,
  inputHash: string
): ClaimUploadRecoveryState {
  if (raw != null) {
    try {
      const state = recoverySchema.parse(
        typeof raw === 'string' ? JSON.parse(raw) : raw
      );
      if (state.inputHash === inputHash) {
        state.newRequest = false;
        return state;
      }
      if (!state.newRequest)
        throw new Error('Claim changed during publication');
    } catch {
      throw new BadRequestException(
        'Invalid persisted claim upload checkpoint'
      );
    }
  }
  return {
    version: 1,
    inputHash,
    startedAt: Date.now(),
    failures: 0,
    attempts: 0,
    progress: 0,
    attemptStartProgress: 0,
    attemptActive: false,
    status: 'uploading',
    files: {}
  };
}

/** Only small public transaction state is persisted. Source bytes stay at their existing URL. */
export class ClaimMediaUploadRecovery {
  private readonly pending = new Set<Promise<void>>();
  constructor(
    readonly state: ClaimUploadRecoveryState,
    private readonly persist: (
      state: ClaimUploadRecoveryState
    ) => Promise<void>,
    private readonly signal: AbortSignal
  ) {}

  async begin(): Promise<void> {
    // A killed invocation cannot record its outcome. Charge it only if it made
    // no durable progress; normal continuations have their own bounded lifetime.
    if (
      this.state.attemptActive &&
      this.state.progress === this.state.attemptStartProgress
    )
      this.state.failures++;
    this.assertRecoverable();
    this.state.attemptActive = true;
    this.state.attemptStartProgress = this.state.progress;
    this.state.attempts++;
    await this.save();
  }

  assertRecoverable(): void {
    if (
      this.state.status === 'failed' ||
      this.state.failures >= CLAIM_UPLOAD_MAX_FAILURES ||
      this.state.attempts >= CLAIM_UPLOAD_MAX_ATTEMPTS ||
      Date.now() - this.state.startedAt >= MAX_RECOVERY_AGE_MS
    )
      throw new BadRequestException('Claim upload recovery budget exhausted');
  }

  readonly publishFile: ClaimFilePublisher = async (
    kind,
    bytes,
    contentType,
    source
  ) => {
    this.signal.throwIfAborted();
    const artifact = this.prepareArtifact(kind, bytes, contentType, source);
    if (kind === 'metadata' && artifact.metadataBytes !== undefined)
      bytes = Buffer.from(artifact.metadataBytes, 'base64');
    if (hash(bytes) !== artifact.sha256 || bytes.length !== artifact.bytes)
      throw new BadRequestException('Claim upload source bytes changed');
    await this.save();
    const result = await arweaveFileUploader.uploadFileWithTransactionId(
      bytes,
      contentType,
      {
        useSourceData: true,
        savedState: artifact.upload as ArweaveUploadState | undefined,
        onState: async (upload, { signal }) => {
          signal.throwIfAborted();
          if (
            artifact.upload &&
            artifact.upload.transaction.id !== upload.transaction.id
          )
            throw new BadRequestException('Claim upload transaction changed');
          const previous = artifact.upload?.chunkIndex ?? 0;
          artifact.upload = { ...upload, data_base64: '' };
          this.state.progress += Math.max(0, upload.chunkIndex - previous);
          // Persist before the uploader starts another chunk. An aborted wait
          // does not undo this write; drain() retains ownership until it settles.
          await this.save();
        }
      },
      { signal: this.signal }
    );
    return { url: result.url };
  };

  private prepareArtifact(
    kind: ClaimMediaUploadKind,
    bytes: Buffer,
    contentType: string,
    source: string
  ) {
    const existing = this.state.files[kind];
    if (existing) {
      if (existing.source !== source || existing.contentType !== contentType)
        throw new BadRequestException('Claim upload source identity changed');
      return existing;
    }
    if (kind === 'metadata' && bytes.length > 750000)
      throw new BadRequestException(
        'Claim metadata checkpoint exceeds the supported size'
      );
    const artifact = {
      source,
      contentType,
      bytes: bytes.length,
      sha256: hash(bytes),
      ...(kind === 'metadata'
        ? { metadataBytes: bytes.toString('base64') }
        : {})
    };
    this.state.files[kind] = artifact;
    return artifact as NonNullable<
      ClaimUploadRecoveryState['files'][ClaimMediaUploadKind]
    >;
  }

  async finishAttempt(failed: boolean): Promise<void> {
    if (failed) this.state.failures++;
    this.state.attemptActive = false;
    await this.save();
  }

  async drain(): Promise<void> {
    // Do not release a lease while a cancelled upload's DB write can still land.
    await Promise.allSettled(Array.from(this.pending));
  }

  private async save(): Promise<void> {
    const write = this.persist(structuredClone(this.state));
    this.pending.add(write);
    try {
      await write;
    } finally {
      this.pending.delete(write);
    }
  }
}
