const MAX_DROPS = 25_000;
const MAX_CONTENT_BYTES = 10_000_000;
const MAX_CONTEXT_ROUNDS = 100;
const MAX_COLLECTION_MS = 120_000;

/**
 * Per-wave and per-author shares of the edition budget. Material beyond a
 * share is left out (and logged) so one busy wave or one prolific author
 * cannot use up the whole budget and stop the edition from publishing.
 */
export interface NewsletterCollectionShares {
  readonly maxDropsPerWave: number;
  readonly maxDropsPerAuthor: number;
  readonly maxContentBytesPerWave: number;
  readonly maxContentBytesPerAuthor: number;
}

export const DEFAULT_NEWSLETTER_COLLECTION_SHARES: NewsletterCollectionShares =
  {
    maxDropsPerWave: 3_000,
    maxDropsPerAuthor: 1_000,
    maxContentBytesPerWave: 1_500_000,
    maxContentBytesPerAuthor: 750_000
  };

export class NewsletterCollectionLimitError extends Error {
  constructor(limit: 'time' | 'drops' | 'content') {
    super(
      `Newsletter collection exceeded its ${limit} budget; refusing incomplete coverage`
    );
    this.name = 'NewsletterCollectionLimitError';
    Object.setPrototypeOf(this, NewsletterCollectionLimitError.prototype);
  }
}

export interface NewsletterContentOwner {
  readonly wave_id: string;
  readonly author_id: string;
}

export interface NewsletterTruncationSummary {
  readonly droppedDropsByWave: Record<string, number>;
  readonly droppedDropsByAuthor: Record<string, number>;
  readonly truncatedContentBytes: number;
  readonly contextTruncated: boolean;
}

function increment(map: Map<string, number>, key: string, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) {
    return text;
  }
  // Cutting may split a multi-byte character; drop the replacement char.
  let kept = bytes.subarray(0, maxBytes).toString('utf8');
  while (kept.endsWith(REPLACEMENT_CHARACTER)) {
    kept = kept.slice(0, -1);
  }
  return kept;
}

/** A per-invocation budget shared by all concurrent wave readers. */
export class NewsletterCollectionBudget {
  private readonly deadline = Date.now() + MAX_COLLECTION_MS;
  private drops = 0;
  private contentBytes = 0;
  private contextRounds = 0;
  private contextTruncated = false;
  private truncatedContentBytes = 0;
  private readonly dropsByWave = new Map<string, number>();
  private readonly dropsByAuthor = new Map<string, number>();
  private readonly bytesByWave = new Map<string, number>();
  private readonly bytesByAuthor = new Map<string, number>();
  private readonly droppedByWave = new Map<string, number>();
  private readonly droppedByAuthor = new Map<string, number>();

  constructor(
    private readonly shares: NewsletterCollectionShares = DEFAULT_NEWSLETTER_COLLECTION_SHARES
  ) {}

  checkTime(): void {
    if (Date.now() >= this.deadline)
      throw new NewsletterCollectionLimitError('time');
  }

  addDrops(count: number): void {
    this.checkTime();
    this.drops += count;
    if (this.drops > MAX_DROPS)
      throw new NewsletterCollectionLimitError('drops');
  }

  /**
   * Keeps the drops that fit their wave's and author's share, counts them
   * against the edition budget, and leaves the rest out.
   */
  admitDrops<T extends NewsletterContentOwner>(drops: readonly T[]): T[] {
    const admitted: T[] = [];
    for (const drop of drops) {
      const waveCount = this.dropsByWave.get(drop.wave_id) ?? 0;
      const authorCount = this.dropsByAuthor.get(drop.author_id) ?? 0;
      if (waveCount >= this.shares.maxDropsPerWave) {
        increment(this.droppedByWave, drop.wave_id, 1);
        continue;
      }
      if (authorCount >= this.shares.maxDropsPerAuthor) {
        increment(this.droppedByAuthor, drop.author_id, 1);
        continue;
      }
      increment(this.dropsByWave, drop.wave_id, 1);
      increment(this.dropsByAuthor, drop.author_id, 1);
      admitted.push(drop);
    }
    this.addDrops(admitted.length);
    return admitted;
  }

  isWaveFull(waveId: string): boolean {
    return (this.dropsByWave.get(waveId) ?? 0) >= this.shares.maxDropsPerWave;
  }

  /**
   * Cuts text that would take its wave or author past their content share.
   * Returns the text to keep ('' once the share is used up).
   */
  admitText(owner: NewsletterContentOwner | undefined, text: string): string {
    if (!owner) {
      return text;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    const waveLeft =
      this.shares.maxContentBytesPerWave -
      (this.bytesByWave.get(owner.wave_id) ?? 0);
    const authorLeft =
      this.shares.maxContentBytesPerAuthor -
      (this.bytesByAuthor.get(owner.author_id) ?? 0);
    const kept = truncateUtf8(text, Math.min(bytes, waveLeft, authorLeft));
    const keptBytes = Buffer.byteLength(kept, 'utf8');
    increment(this.bytesByWave, owner.wave_id, keptBytes);
    increment(this.bytesByAuthor, owner.author_id, keptBytes);
    this.truncatedContentBytes += bytes - keptBytes;
    return kept;
  }

  addContent(texts: string[]): void {
    this.checkTime();
    for (const text of texts)
      this.contentBytes += Buffer.byteLength(text, 'utf8');
    if (this.contentBytes > MAX_CONTENT_BYTES)
      throw new NewsletterCollectionLimitError('content');
  }

  /**
   * Returns false once reply/quote context has been followed for the maximum
   * number of rounds; deeper background is left out instead of failing.
   */
  nextContextRound(): boolean {
    this.checkTime();
    if (this.contextRounds >= MAX_CONTEXT_ROUNDS) {
      this.contextTruncated = true;
      return false;
    }
    this.contextRounds++;
    return true;
  }

  truncationSummary(): NewsletterTruncationSummary | null {
    if (
      !this.droppedByWave.size &&
      !this.droppedByAuthor.size &&
      !this.truncatedContentBytes &&
      !this.contextTruncated
    ) {
      return null;
    }
    return {
      droppedDropsByWave: Object.fromEntries(this.droppedByWave),
      droppedDropsByAuthor: Object.fromEntries(this.droppedByAuthor),
      truncatedContentBytes: this.truncatedContentBytes,
      contextTruncated: this.contextTruncated
    };
  }
}
