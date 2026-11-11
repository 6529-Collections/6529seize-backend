/** Nearest-rank percentile; `values` need not be sorted. Empty input → null. */
export function percentile(
  values: readonly number[],
  p: number
): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(
    sorted.length,
    Math.max(1, Math.ceil((p / 100) * sorted.length))
  );
  return sorted[rank - 1];
}

export interface Distribution {
  readonly count: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

export function distribution(values: readonly number[]): Distribution {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length ? Math.max(...values) : null
  };
}

/** One post as the author saw it. */
export interface ProbePost {
  readonly index: number;
  readonly postedAt: number;
  readonly respondedAt: number | null;
  readonly dropId: string | null;
  readonly status: number | null;
}

/** One frame for a probe post, as one listener socket received it. */
export interface ProbeReceipt {
  readonly index: number;
  readonly listener: number;
  readonly receivedAt: number;
  readonly serverReceivedAt: number | null;
  readonly sentAt: number | null;
}

export interface ProbeSummary {
  readonly posts: number;
  readonly failedPosts: number;
  readonly listeners: number;
  /** Author's "sent": POST start to response, on the probe's clock. */
  readonly postResponseMs: Distribution;
  /** POST start to frame receipt, per listener and post (one clock). */
  readonly deliveryMs: Distribution;
  /** POST start to the last listener's receipt, per post. */
  readonly lastListenerDeliveryMs: Distribution;
  /** Server clock: request receipt to this frame's gateway hand-off. */
  readonly serverFanoutMs: Distribution;
  /** Frames that arrived before the author's POST returned. */
  readonly deliveredBeforeResponse: number;
  /** Expected receipts that never arrived. */
  readonly missing: number;
  /** Extra copies of a post on one socket ("each tab once" target: 0). */
  readonly duplicates: number;
}

export function summarizeProbe({
  posts,
  receipts,
  listeners
}: {
  posts: readonly ProbePost[];
  receipts: readonly ProbeReceipt[];
  listeners: number;
}): ProbeSummary {
  const delivered = posts.filter(
    (post) => post.respondedAt !== null && post.dropId !== null
  );
  const byPost = new Map<number, ProbePost>(
    delivered.map((post) => [post.index, post])
  );
  const firstReceipts = new Map<string, ProbeReceipt>();
  let duplicates = 0;
  for (const receipt of receipts) {
    if (!byPost.has(receipt.index)) continue;
    const key = `${receipt.index}:${receipt.listener}`;
    const existing = firstReceipts.get(key);
    if (existing) {
      duplicates++;
      if (receipt.receivedAt < existing.receivedAt)
        firstReceipts.set(key, receipt);
    } else {
      firstReceipts.set(key, receipt);
    }
  }
  const deliveryMs: number[] = [];
  const serverFanoutMs: number[] = [];
  const lastByPost = new Map<number, number>();
  let deliveredBeforeResponse = 0;
  for (const receipt of Array.from(firstReceipts.values())) {
    const post = byPost.get(receipt.index)!;
    const latency = receipt.receivedAt - post.postedAt;
    deliveryMs.push(latency);
    lastByPost.set(
      receipt.index,
      Math.max(lastByPost.get(receipt.index) ?? 0, latency)
    );
    if (post.respondedAt !== null && receipt.receivedAt < post.respondedAt)
      deliveredBeforeResponse++;
    if (receipt.serverReceivedAt !== null && receipt.sentAt !== null)
      serverFanoutMs.push(receipt.sentAt - receipt.serverReceivedAt);
  }
  return {
    posts: posts.length,
    failedPosts: posts.length - delivered.length,
    listeners,
    postResponseMs: distribution(
      delivered.map((post) => post.respondedAt! - post.postedAt)
    ),
    deliveryMs: distribution(deliveryMs),
    lastListenerDeliveryMs: distribution(Array.from(lastByPost.values())),
    serverFanoutMs: distribution(serverFanoutMs),
    deliveredBeforeResponse,
    missing: delivered.length * listeners - firstReceipts.size,
    duplicates
  };
}
