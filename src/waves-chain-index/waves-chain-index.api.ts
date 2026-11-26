import {
  chainGatewayConfigFromEnv,
  ChainGatewayClient,
  ChainGatewayError
} from '@/chain-gateway/chain-gateway.client';
import {
  ChainFeedBlock,
  ChainFeedPage
} from '@/chain-gateway/chain-gateway.types';

/**
 * The node API's rule-version-7 objects, as the index reads them. Each
 * holds more fields than the index's columns: the index keeps the whole
 * object.
 */
export type ChainObject = Record<string, unknown>;

export interface ChainPage<T> {
  readonly items: T[];
  /** The `after` of the next page; null when the list ended. */
  readonly next: string | null;
}

export interface WavesImportState {
  readonly completed: boolean;
}

export interface WavesChainHead {
  readonly finalizedHeight: number;
  /**
   * The finalized block's time (ms): what the reads at it compare with.
   * Null only when neither the status nor `/v1/blocks/{height}` gave it.
   */
  readonly finalizedTime: number | null;
  /** The chain's network id; another one means a relaunched chain. */
  readonly network: string | null;
}

/**
 * What the index reads: the gateway, or a fake in tests. Every read is
 * pinned to the height `at`, so one run's reads agree.
 */
export interface WavesChainApi {
  head(): Promise<WavesChainHead>;
  /** The waves import's cursor; null before the node answers it. */
  importState(at: number): Promise<WavesImportState | null>;
  listGroups(after: string | null, at: number): Promise<ChainPage<ChainObject>>;
  listWaves(after: string | null, at: number): Promise<ChainPage<ChainObject>>;
  listDecisions(
    after: string | null,
    at: number
  ): Promise<ChainPage<ChainObject>>;
  group(id: string, at: number): Promise<ChainObject | null>;
  wave(id: string, at: number): Promise<ChainObject | null>;
  decision(id: string, at: number): Promise<ChainObject | null>;
  entry(id: string, at: number): Promise<ChainObject | null>;
  poll(id: string, at: number): Promise<ChainObject | null>;
  result(
    decisionId: string,
    resultTime: number,
    at: number
  ): Promise<ChainObject | null>;
  decisionLeaderboard(
    decisionId: string,
    at: number
  ): Promise<ChainObject | null>;
  /** Every item of a per-object list (all pages); null when the object is gone. */
  waveRoles(waveId: string, at: number): Promise<ChainObject[] | null>;
  wavePolls(waveId: string, at: number): Promise<ChainObject[] | null>;
  waveRep(waveId: string, at: number): Promise<ChainObject[] | null>;
  /** A page of a decision's entries, every status, ascending by id. */
  decisionEntries(
    decisionId: string,
    after: string | null,
    at: number
  ): Promise<ChainPage<ChainObject>>;
  decisionResults(
    decisionId: string,
    at: number
  ): Promise<ChainObject[] | null>;
  entryVotes(entryId: string, at: number): Promise<ChainObject[] | null>;
  feed(from: number, families: readonly string[]): Promise<ChainFeedPage>;
}

const LIST_LIMIT = 500;
/** The leaderboard route's largest page. */
export const LEADERBOARD_LIMIT = 1024;
const FEED_LIMIT = 200;
/**
 * The most one block's feed records may take, read across pages, before
 * the feed gives up on it (a gateway page fills to 4 MiB: 64 MiB is about
 * 16 full pages), and the most pages it may take.
 */
export const FEED_BLOCK_LIMITS = {
  maxBytes: 64 * 1024 * 1024,
  maxPages: 256
};
/**
 * The index reads each height once, so pinned answers are never read again:
 * its own client keeps few of them (the shared client keeps 10,000).
 */
const INDEX_CLIENT_CACHE_ENTRIES = 64;

/** The gateway client the index uses: the shared settings, a small cache. */
export function wavesIndexGatewayClient(): ChainGatewayClient {
  return new ChainGatewayClient(() => ({
    ...chainGatewayConfigFromEnv(),
    cacheEntries: INDEX_CLIENT_CACHE_ENTRIES
  }));
}

function asArray(data: unknown): ChainObject[] {
  if (Array.isArray(data)) return data as ChainObject[];
  // Some lists answer an object holding the list.
  if (data && typeof data === 'object') {
    for (const value of Object.values(data as ChainObject)) {
      if (Array.isArray(value)) return value as ChainObject[];
    }
  }
  return [];
}

/**
 * A page whose `next` repeats the cursor it was asked from: a gateway
 * fault, never the end of a list. Taken as the end, a full read would sweep
 * the rows it never saw, and a replaced list (a wave's roles, an entry's
 * votes) would lose the rest. Thrown as the client's typed lists do.
 */
export function repeatedCursor(path: string, after: string): ChainGatewayError {
  return new ChainGatewayError(
    `${path}: a page whose next repeats the cursor it was asked from (${after})`,
    200,
    'bad_answer',
    path
  );
}

function recordBytes(block: ChainFeedBlock): number {
  return block.records.reduce((n, r) => n + JSON.stringify(r).length, 0);
}

export class GatewayWavesChainApi implements WavesChainApi {
  constructor(
    private readonly client: Pick<
      ChainGatewayClient,
      'read' | 'getHead' | 'getChanges'
    > = wavesIndexGatewayClient(),
    private readonly feedBlockLimits: typeof FEED_BLOCK_LIMITS = FEED_BLOCK_LIMITS
  ) {}

  async head(): Promise<WavesChainHead> {
    const head = await this.client.getHead(true);
    return {
      finalizedHeight: head.finalizedHeight,
      // The status gives the answering node's own block time only: when the
      // client's pin is above that node's height, the pinned block's time
      // is read from the chain. Null (the run waits) only if that fails too.
      finalizedTime:
        head.finalizedTime ?? (await this.blockTime(head.finalizedHeight)),
      network: head.network ?? null
    };
  }

  /**
   * A finalized block's slot start (ms) from `/v1/blocks/{height}`, read at
   * that height; null when it can't be read or isn't a time.
   */
  async blockTime(height: number): Promise<number | null> {
    try {
      const answer = await this.client.read<{
        height?: unknown;
        time?: unknown;
      }>(`/v1/blocks/${height}`, {}, { height });
      const data = answer?.data;
      if (data?.height !== undefined && Number(data.height) !== height) {
        return null;
      }
      const time = Number(data?.time);
      return Number.isSafeInteger(time) && time > 0 ? time : null;
    } catch {
      return null;
    }
  }

  async importState(at: number): Promise<WavesImportState | null> {
    const answer = await this.client.read<ChainObject>(
      '/v1/waves/import',
      {},
      { height: at }
    );
    const data = answer?.data;
    return data ? { completed: data.completed === true } : null;
  }

  private async page(
    path: string,
    after: string | null,
    at: number,
    query: Record<string, string> = {}
  ): Promise<ChainPage<ChainObject>> {
    const answer = await this.client.read<unknown>(
      path,
      { ...query, limit: LIST_LIMIT, after: after ?? undefined },
      { height: at }
    );
    if (!answer && after !== null) {
      // The list was there a page ago at this same height: an empty last
      // page here would let a full read's sweep drop the rest.
      throw new ChainGatewayError(
        `${path}: a later page was not found`,
        404,
        'not_found',
        path
      );
    }
    if (after !== null && answer?.next === after) {
      throw repeatedCursor(path, after);
    }
    return {
      items: answer ? asArray(answer.data) : [],
      next: answer?.next ?? null
    };
  }

  private async object(
    path: string,
    at: number,
    query: Record<string, number> = {}
  ): Promise<ChainObject | null> {
    const answer = await this.client.read<ChainObject>(path, query, {
      height: at
    });
    return answer?.data ?? null;
  }

  private async all(
    path: string,
    at: number,
    query: Record<string, string> = {}
  ): Promise<ChainObject[] | null> {
    const items: ChainObject[] = [];
    let after: string | null = null;
    for (;;) {
      const answer: Awaited<ReturnType<ChainGatewayClient['read']>> =
        await this.client.read<unknown>(
          path,
          { ...query, limit: LIST_LIMIT, after: after ?? undefined },
          { height: at }
        );
      if (!answer) {
        if (after === null) return null;
        // The list was there a page ago at this same height.
        throw new ChainGatewayError(
          `${path}: a later page was not found`,
          404,
          'not_found',
          path
        );
      }
      if (after !== null && answer.next === after) {
        throw repeatedCursor(path, after);
      }
      items.push(...asArray(answer.data));
      if (!answer.next) return items;
      after = answer.next;
    }
  }

  listGroups(after: string | null, at: number) {
    return this.page('/v1/groups', after, at);
  }

  listWaves(after: string | null, at: number) {
    return this.page('/v1/waves', after, at);
  }

  listDecisions(after: string | null, at: number) {
    return this.page('/v1/decisions', after, at);
  }

  group(id: string, at: number) {
    return this.object(`/v1/groups/${id}`, at);
  }

  wave(id: string, at: number) {
    return this.object(`/v1/waves/${id}`, at);
  }

  decision(id: string, at: number) {
    return this.object(`/v1/decisions/${id}`, at);
  }

  entry(id: string, at: number) {
    return this.object(`/v1/entries/${id}`, at);
  }

  poll(id: string, at: number) {
    return this.object(`/v1/polls/${id}`, at);
  }

  result(decisionId: string, resultTime: number, at: number) {
    return this.object(`/v1/decisions/${decisionId}/results/${resultTime}`, at);
  }

  decisionLeaderboard(decisionId: string, at: number) {
    return this.object(`/v1/decisions/${decisionId}/leaderboard`, at, {
      limit: LEADERBOARD_LIMIT
    });
  }

  waveRoles(waveId: string, at: number) {
    return this.all(`/v1/waves/${waveId}/roles`, at);
  }

  wavePolls(waveId: string, at: number) {
    return this.all(`/v1/waves/${waveId}/polls`, at);
  }

  waveRep(waveId: string, at: number) {
    return this.all(`/v1/waves/${waveId}/rep/ratings`, at);
  }

  decisionEntries(decisionId: string, after: string | null, at: number) {
    return this.page(`/v1/decisions/${decisionId}/entries`, after, at, {
      status: 'all'
    });
  }

  decisionResults(decisionId: string, at: number) {
    return this.all(`/v1/decisions/${decisionId}/results`, at);
  }

  entryVotes(entryId: string, at: number) {
    return this.all(`/v1/entries/${entryId}/votes`, at);
  }

  /**
   * A page of the feed holding whole blocks only, as the index applies
   * them. A gateway page can end inside a block (its `next` is then
   * `height:index` and the block is marked `complete: false`):
   * - whole blocks before that block come back alone, and the next page
   *   starts at it;
   * - a block that is the page's only one is read on from that cursor,
   *   with the same families, until it is complete, and comes back whole.
   * A block past FEED_BLOCK_LIMITS throws rather than reading without end.
   */
  async feed(
    from: number,
    families: readonly string[]
  ): Promise<ChainFeedPage> {
    const opts = { limit: FEED_LIMIT, families: [...families] };
    const first = await this.client.getChanges(from, opts);
    const last = first.blocks[first.blocks.length - 1];
    if (!last || last.complete !== false) return first;
    if (first.blocks.length > 1) {
      return {
        ...first,
        blocks: first.blocks.slice(0, -1),
        next: first.nextHeight
      };
    }
    const limits = this.feedBlockLimits;
    let block = last;
    let page = first;
    let pages = 1;
    let bytes = recordBytes(block);
    while (block.complete === false) {
      if (pages >= limits.maxPages || bytes > limits.maxBytes) {
        throw new Error(
          `[FEED BLOCK TOO LARGE] block ${block.height}: its feed records passed ${pages} pages and ${bytes} bytes (limits ${limits.maxPages} pages, ${limits.maxBytes} bytes); the index applies whole blocks only`
        );
      }
      const asked = page.next;
      page = await this.client.getChanges(asked, {
        ...opts,
        network: first.network ?? undefined
      });
      pages++;
      if (page.blocks.length && String(page.next) === String(asked)) {
        throw repeatedCursor('/v1/feed', String(asked));
      }
      const rest = page.blocks[0];
      if (!rest) {
        // A node behind the block: nothing past the height before it now.
        return {
          ...first,
          blocks: [],
          through: block.height - 1,
          next: block.height,
          nextHeight: block.height,
          atHead: true
        };
      }
      if (rest.height !== block.height) {
        throw new Error(
          `[FEED BLOCK BROKEN] block ${block.height}: the page from ${String(page.from)} goes on with block ${rest.height}`
        );
      }
      bytes += recordBytes(rest);
      block = {
        ...rest,
        recordsFrom: block.recordsFrom,
        records: [...block.records, ...rest.records]
      };
    }
    return {
      ...first,
      through: block.height,
      blocks: [block],
      next: block.height + 1,
      nextHeight: block.height + 1,
      atHead: false
    };
  }
}
