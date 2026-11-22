import {
  ChainGatewayClient,
  chainGatewayClient
} from '@/chain-gateway/chain-gateway.client';
import {
  ChainDelegation,
  ChainIdentity,
  ChainReadOptions
} from '@/chain-gateway/chain-gateway.types';
import { appFeatures } from '@/app-features';
import { DELEGATION_ALL_ADDRESS, USE_CASE_ALL } from '@/constants';
import { DelegationRowWrite, toDelegationRow } from './delegation-rows';

/** Step two: delegation reads come from the 6529 chain (FEATURE_DELEGATIONS_FROM_CHAIN). */
export function delegationsFromChain(): boolean {
  return appFeatures.isDelegationsFromChainEnabled();
}

type Gateway = Pick<
  ChainGatewayClient,
  | 'getHead'
  | 'getDelegations'
  | 'getDelegationsOfWallet'
  | 'getIdentityByPrincipal'
>;

export interface ProcessedDelegations {
  /** The finalized chain height the list was read at. */
  readonly height: number;
  readonly rows: DelegationRowWrite[];
}

/** The rank 6529.io gives a record for a collection and use case (1 best). */
function priority(
  row: DelegationRowWrite,
  collection: string,
  useCase: number
): number {
  const sameCollection = row.collection === collection;
  const anyCollection = row.collection === DELEGATION_ALL_ADDRESS;
  if (sameCollection && row.use_case === useCase) return 1;
  if (sameCollection && row.use_case === USE_CASE_ALL) return 2;
  if (anyCollection && row.use_case === useCase) return 3;
  if (anyCollection && row.use_case === USE_CASE_ALL) return 4;
  return 5;
}

/**
 * NFTDelegation's resolution, as fetchProcessedDelegations does it in SQL:
 * per delegating wallet, the most specific record (collection, then use
 * case) and within that the latest block wins; token-specific records count
 * only for their token; expiry is checked after choosing, so an expired
 * specific record hides a live general one. Newest first.
 */
export function resolveDelegations(
  rows: readonly DelegationRowWrite[],
  {
    collection,
    useCase,
    tokenId,
    nowSeconds,
    wallets
  }: {
    collection: string;
    useCase: number;
    tokenId?: number | null;
    nowSeconds: number;
    wallets?: string[];
  }
): DelegationRowWrite[] {
  const wanted = collection.toLowerCase();
  const allowed = wallets
    ? new Set(wallets.map((it) => it.toLowerCase()))
    : null;
  const best = new Map<string, DelegationRowWrite>();
  for (const row of rows) {
    if (row.collection !== wanted && row.collection !== DELEGATION_ALL_ADDRESS)
      continue;
    if (row.use_case !== useCase && row.use_case !== USE_CASE_ALL) continue;
    const inScope =
      row.all_tokens ||
      (tokenId !== undefined &&
        tokenId !== null &&
        row.collection === wanted &&
        Number(row.token_id) === Number(tokenId));
    if (!inScope) continue;
    const current = best.get(row.from_address);
    if (
      !current ||
      priority(row, wanted, useCase) < priority(current, wanted, useCase) ||
      (priority(row, wanted, useCase) === priority(current, wanted, useCase) &&
        row.block > current.block)
    ) {
      best.set(row.from_address, row);
    }
  }
  return Array.from(best.values())
    .filter((it) => it.expiry >= nowSeconds)
    .filter((it) => !allowed || allowed.has(it.from_address))
    .sort((a, b) => b.block - a.block);
}

/**
 * Delegation reads from the 6529 chain at one finalized height: the rows
 * 6529.io's delegations table would hold (an identity's record covers each
 * of its wallets), resolved as fetchProcessedDelegations resolves them.
 */
export class ChainDelegations {
  constructor(
    private readonly gateway: Gateway = chainGatewayClient,
    private readonly now: () => number = () => Date.now()
  ) {}

  private async pages(
    query: Parameters<Gateway['getDelegations']>[0],
    opts: ChainReadOptions
  ): Promise<ChainDelegation[]> {
    const records: ChainDelegation[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await this.gateway.getDelegations(query, {
        ...opts,
        after,
        limit: 1000
      });
      records.push(...(page?.items ?? []));
      if (!page?.next) return records;
      after = page.next;
    }
  }

  /** Each wallet's rows: its own records and its identity's. */
  async rowsOfWallets(
    wallets: string[],
    opts: ChainReadOptions
  ): Promise<DelegationRowWrite[]> {
    const rows: DelegationRowWrite[] = [];
    for (const wallet of Array.from(
      new Set(wallets.map((it) => it.toLowerCase()))
    )) {
      const groups =
        (await this.gateway.getDelegationsOfWallet(wallet, opts)) ?? [];
      for (const group of groups) {
        const records = group.more
          ? await this.pages({ holder: group.holder }, opts)
          : group.records;
        for (const record of records) {
          const row = toDelegationRow(wallet, record);
          if (row) rows.push(row);
        }
      }
    }
    return rows;
  }

  /** Every wallet's rows for these use cases. */
  async rowsOfUseCases(
    useCases: number[],
    opts: ChainReadOptions
  ): Promise<DelegationRowWrite[]> {
    const identities = new Map<string, ChainIdentity | null>();
    const walletsOf = async (record: ChainDelegation) => {
      if (record.scope === 'wallet') return [record.holder.toLowerCase()];
      const key = record.holder.toLowerCase();
      if (!identities.has(key)) {
        identities.set(
          key,
          await this.gateway.getIdentityByPrincipal(key, opts)
        );
      }
      return identities.get(key)?.wallets.map((it) => it.toLowerCase()) ?? [];
    };
    const rows: DelegationRowWrite[] = [];
    for (const useCase of Array.from(new Set(useCases))) {
      for (const record of await this.pages({ byUseCase: useCase }, opts)) {
        for (const wallet of await walletsOf(record)) {
          const row = toDelegationRow(wallet, record);
          if (row) rows.push(row);
        }
      }
    }
    return rows;
  }

  /** fetchProcessedDelegations, read from the chain at one height. */
  async processedDelegations(
    collection: string,
    useCase: number,
    wallets?: string[],
    tokenId?: number | null,
    height?: number
  ): Promise<ProcessedDelegations> {
    const pinned = height ?? (await this.gateway.getHead()).finalizedHeight;
    const opts = { height: pinned };
    const rows = wallets
      ? await this.rowsOfWallets(wallets, opts)
      : await this.rowsOfUseCases([useCase, USE_CASE_ALL], opts);
    return {
      height: pinned,
      rows: resolveDelegations(rows, {
        collection,
        useCase,
        tokenId,
        nowSeconds: this.now() / 1000,
        wallets
      })
    };
  }
}

export const chainDelegations = new ChainDelegations();
