const MAX_DROPS = 25_000;
const MAX_CONTENT_BYTES = 10_000_000;
const MAX_CONTEXT_ROUNDS = 100;
const MAX_COLLECTION_MS = 120_000;

export class NewsletterCollectionLimitError extends Error {
  constructor(limit: 'time' | 'drops' | 'content' | 'context-depth') {
    super(
      `Newsletter collection exceeded its ${limit} budget; refusing incomplete coverage`
    );
    this.name = 'NewsletterCollectionLimitError';
    Object.setPrototypeOf(this, NewsletterCollectionLimitError.prototype);
  }
}

/** A per-invocation budget shared by all concurrent wave readers. */
export class NewsletterCollectionBudget {
  private readonly deadline = Date.now() + MAX_COLLECTION_MS;
  private drops = 0;
  private contentBytes = 0;
  private contextRounds = 0;

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

  addContent(texts: string[]): void {
    this.checkTime();
    for (const text of texts)
      this.contentBytes += Buffer.byteLength(text, 'utf8');
    if (this.contentBytes > MAX_CONTENT_BYTES)
      throw new NewsletterCollectionLimitError('content');
  }

  nextContextRound(): void {
    this.checkTime();
    this.contextRounds++;
    if (this.contextRounds > MAX_CONTEXT_ROUNDS)
      throw new NewsletterCollectionLimitError('context-depth');
  }
}
