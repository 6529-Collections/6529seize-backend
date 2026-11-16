import { randomBytes } from 'node:crypto';
import {
  CloudFrontClient,
  CreateInvalidationCommand
} from '@aws-sdk/client-cloudfront';

/** Paths per CreateInvalidation request (CloudFront allows 3,000 in flight). */
export const INVALIDATION_BATCH_SIZE = 1000;
const MAX_THROTTLE_RETRIES = 8;

export interface CdnInvalidator {
  invalidate(paths: string[]): Promise<void>;
}

export type Sleep = (millis: number) => Promise<void>;

const defaultSleep: Sleep = (millis) =>
  new Promise((resolve) => setTimeout(resolve, millis));

function isThrottled(error: unknown): boolean {
  const name = (error as { name?: string })?.name ?? '';
  return name === 'TooManyInvalidationsInProgress' || name === 'Throttling';
}

export class CloudFrontInvalidator implements CdnInvalidator {
  constructor(
    private readonly distributionId: string,
    private readonly client = new CloudFrontClient({ region: 'us-east-1' }),
    private readonly sleep: Sleep = defaultSleep
  ) {}

  async invalidate(paths: string[]): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.client.send(
          new CreateInvalidationCommand({
            DistributionId: this.distributionId,
            InvalidationBatch: {
              CallerReference: `media-metadata-backfill-${Date.now()}-${randomBytes(4).toString('hex')}`,
              Paths: { Quantity: paths.length, Items: paths }
            }
          })
        );
        return;
      } catch (error) {
        if (!isThrottled(error) || attempt >= MAX_THROTTLE_RETRIES) throw error;
        await this.sleep(Math.min(5 * 60_000, 15_000 * 2 ** attempt));
      }
    }
  }
}

/**
 * Collects paths of rewritten objects and submits them in batches, so a run
 * creates few invalidations. Callers flush at page ends and at the end.
 */
export class InvalidationQueue {
  private pending: string[] = [];
  submitted = 0;
  batches = 0;

  constructor(
    private readonly invalidator: CdnInvalidator,
    private readonly batchSize = INVALIDATION_BATCH_SIZE
  ) {}

  add(paths: string[]): void {
    this.pending.push(...paths);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  async flushFullBatches(): Promise<void> {
    while (this.pending.length >= this.batchSize) {
      await this.submit(this.pending.slice(0, this.batchSize));
    }
  }

  async flush(): Promise<void> {
    await this.flushFullBatches();
    if (this.pending.length) await this.submit(this.pending.slice());
  }

  private async submit(batch: string[]): Promise<void> {
    const unique = Array.from(new Set(batch));
    await this.invalidator.invalidate(unique);
    this.pending = this.pending.slice(batch.length);
    this.submitted += unique.length;
    this.batches++;
  }
}
