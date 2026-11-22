import {
  chainGatewayClient,
  ChainGatewayClient
} from '@/chain-gateway/chain-gateway.client';
import { ChainFeedPage } from '@/chain-gateway/chain-gateway.types';

/**
 * The node API's rule-version-7 objects (D:/t/waves/WAVES-API.md), as the
 * index reads them. Each holds more fields than the index's columns: the
 * index keeps the whole object.
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

/**
 * What the index reads: the gateway, or a fake in tests. Every read is
 * pinned to the height `at`, so one run's reads agree.
 */
export interface WavesChainApi {
  finalizedHeight(): Promise<number>;
  /** The waves import's cursor; null before the node answers it. */
  importState(): Promise<WavesImportState | null>;
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
  decisionEntries(
    decisionId: string,
    at: number
  ): Promise<ChainObject[] | null>;
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

export class GatewayWavesChainApi implements WavesChainApi {
  constructor(
    private readonly client: Pick<
      ChainGatewayClient,
      'read' | 'getHead' | 'getChanges'
    > = chainGatewayClient
  ) {}

  async finalizedHeight(): Promise<number> {
    return (await this.client.getHead(true)).finalizedHeight;
  }

  async importState(): Promise<WavesImportState | null> {
    const answer = await this.client.read<ChainObject>(
      '/v1/waves/import',
      {},
      { at: 'head' }
    );
    const data = answer?.data;
    return data ? { completed: data.completed === true } : null;
  }

  private async page(
    path: string,
    after: string | null,
    at: number
  ): Promise<ChainPage<ChainObject>> {
    const answer = await this.client.read<unknown>(
      path,
      { limit: LIST_LIMIT, after: after ?? undefined },
      { height: at }
    );
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
      if (!answer) return after === null ? null : items;
      items.push(...asArray(answer.data));
      if (!answer.next || answer.next === after) return items;
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

  decisionEntries(decisionId: string, at: number) {
    return this.all(`/v1/decisions/${decisionId}/entries`, at, {
      status: 'all'
    });
  }

  decisionResults(decisionId: string, at: number) {
    return this.all(`/v1/decisions/${decisionId}/results`, at);
  }

  entryVotes(entryId: string, at: number) {
    return this.all(`/v1/entries/${entryId}/votes`, at);
  }

  feed(from: number, families: readonly string[]) {
    return this.client.getChanges(from, {
      limit: FEED_LIMIT,
      families: [...families]
    });
  }
}
