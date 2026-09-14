import { createHash } from 'node:crypto';
import {
  ApiNftActivityEvent,
  ApiNftActivityEventKindEnum
} from '@/api/generated/models/ApiNftActivityEvent';
import { ApiNftActivityPage } from '@/api/generated/models/ApiNftActivityPage';
import { ApiTransaction } from '@/api/generated/models/ApiTransaction';
import { GetNftMarketActivityQuery } from '@/api/generated/routes/operations';
import {
  MANIFOLD,
  ENS_TABLE,
  MARKET_DEPTH_EVENTS_TABLE,
  NULL_ADDRESS,
  NULL_ADDRESS_DEAD,
  TRANSACTIONS_TABLE
} from '@/constants';
import { resolveEns } from '@/db-api';
import { DbPoolName } from '@/db-query.options';
import { BadRequestException } from '@/exceptions';
import { MarketDepthEventInput } from '@/market-depth/market-depth.types';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { MARKET_CONTRACTS, marketDepthApiDb } from './market-depth-api.db';
import {
  decodeMarketCursor,
  encodeMarketCursor
} from './market-depth.validation';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const ACTIVITY_NOTES = [
  'Sales, mints, transfers and burns come from indexed on-chain transactions.',
  'Sales and purchases select the same trades without a wallet filter; with wallets, sales select sellers and purchases select buyers.',
  'Marketplace history combines recorded OpenSea events and observed order statuses. Live delivery is best effort; events before capture may be unavailable.'
];

const MARKET_ACTIONS: Record<string, string> = {
  listing: 'listing',
  item_listed: 'listing',
  listing_created: 'listing',
  offer: 'offer',
  item_received_bid: 'offer',
  offer_created: 'offer',
  collection_offer: 'offer',
  trait_offer: 'offer',
  cancellation: 'cancellation',
  cancel: 'cancellation',
  cancelled: 'cancellation',
  item_cancelled: 'cancellation',
  listing_cancelled: 'cancellation',
  offer_cancelled: 'cancellation',
  expiration: 'expiration',
  expire: 'expiration',
  expired: 'expiration',
  invalidation: 'invalidation',
  inactive: 'invalidation',
  invalidate: 'invalidation',
  order_invalidate: 'invalidation',
  revalidation: 'revalidation',
  revalidate: 'revalidation',
  order_revalidate: 'revalidation'
};
const CHAIN_MARKET_KINDS = [
  'sale',
  'sold',
  'item_sold',
  'transfer',
  'item_transferred',
  'mint'
];

interface ActivityCursor {
  v: 1;
  fingerprint: string;
  at: string;
  id: string;
}

interface TransactionRow extends ApiTransaction {
  event_key: string;
  exact_token_id: string;
  occurred_at: Date;
}

interface MarketEventRow extends MarketDepthEventInput {
  occurred_at: Date;
}

interface ActivitySelection {
  contracts: string[];
  tokenId?: string;
  wallets: string[];
  walletRequested: boolean;
  slugs?: string[];
  filter: string;
  limit: number;
  cursor: ActivityCursor | null;
}

function classifyTransaction(row: ApiTransaction): string {
  const from = row.from_address.toLowerCase();
  const to = row.to_address.toLowerCase();
  if (
    to === NULL_ADDRESS.toLowerCase() ||
    to === NULL_ADDRESS_DEAD.toLowerCase()
  )
    return 'burn';
  if (from === NULL_ADDRESS.toLowerCase() || from === MANIFOLD.toLowerCase())
    return row.value > 0 ? 'mint' : 'airdrop';
  return row.value > 0 ? 'sale' : 'transfer';
}

export function transactionToActivity(
  row: TransactionRow
): ApiNftActivityEvent {
  const date = new Date(row.transaction_date);
  return {
    event_id: `t:${row.event_key}`,
    kind: ApiNftActivityEventKindEnum.Transaction,
    action: classifyTransaction(row),
    occurred_at: date,
    observed_at: new Date(row.created_at),
    source: 'ethereum',
    evidence: 'chain',
    contract: row.contract.toLowerCase(),
    token_id: row.exact_token_id,
    collection_slug: null,
    quantity: String(row.token_count),
    maker: row.from_address,
    taker: row.to_address,
    price: String(row.value),
    currency: { address: NULL_ADDRESS, symbol: 'ETH', decimals: 18 },
    order_id: null,
    transaction_hash: row.transaction,
    transaction_details: row
  };
}

export function marketEventToActivity(
  row: MarketEventRow
): ApiNftActivityEvent {
  return {
    event_id: `m:${row.event_id}`,
    kind: ApiNftActivityEventKindEnum.Market,
    action: MARKET_ACTIONS[row.kind.toLowerCase()] ?? row.kind.toLowerCase(),
    occurred_at: new Date(row.provider_at ?? row.observed_at),
    observed_at: new Date(row.observed_at),
    source: row.source,
    evidence: row.source_evidence ?? 'observed_status',
    contract: row.contract,
    token_id: row.token_id,
    collection_slug: row.collection_slug,
    quantity: row.quantity,
    maker: row.maker,
    taker: row.taker,
    price: row.price_decimal,
    ...(row.currency_contract &&
    row.currency_symbol &&
    row.currency_decimals !== null
      ? {
          currency: {
            address: row.currency_contract,
            symbol: row.currency_symbol,
            decimals: row.currency_decimals
          }
        }
      : {}),
    order_id: row.order_id,
    transaction_hash: row.transaction_hash
  };
}

function compareActivity(
  a: ApiNftActivityEvent,
  b: ApiNftActivityEvent
): number {
  return (
    b.occurred_at.getTime() - a.occurred_at.getTime() ||
    b.event_id.localeCompare(a.event_id)
  );
}

function selectedMarketKinds(filter: string): string[] | null {
  if (filter === 'all') return null;
  const action = (
    {
      listings: 'listing',
      offers: 'offer',
      cancellations: 'cancellation',
      expirations: 'expiration',
      invalidations: 'invalidation',
      revalidations: 'revalidation'
    } as Record<string, string>
  )[filter];
  return Object.entries(MARKET_ACTIONS)
    .filter(([, value]) => value === action)
    .map(([key]) => key);
}

function transactionTypePredicate(filter: string): string | null {
  const ordinary =
    't.from_address NOT IN (:zero,:manifold) AND t.to_address NOT IN (:zero,:dead)';
  switch (filter) {
    case 'all':
      return '1=1';
    case 'sales':
    case 'purchases':
      return `t.value > 0 AND ${ordinary}`;
    case 'mints':
      return 't.value > 0 AND t.from_address IN (:zero,:manifold) AND t.to_address NOT IN (:zero,:dead)';
    case 'airdrops':
      return 't.value = 0 AND t.from_address IN (:zero,:manifold) AND t.to_address NOT IN (:zero,:dead)';
    case 'burns':
      return 't.to_address IN (:zero,:dead)';
    case 'transfers':
      return `t.value = 0 AND ${ordinary}`;
    default:
      return null;
  }
}

export class NftMarketActivityService extends LazyDbAccessCompatibleService {
  private async transactionEvents(
    selection: ActivitySelection
  ): Promise<ApiNftActivityEvent[]> {
    const type = transactionTypePredicate(selection.filter);
    if (!type) return [];
    const eventKey =
      "SHA2(CONCAT_WS(':',t.transaction,t.from_address,t.to_address,t.contract,CAST(t.token_id AS CHAR)),256)";
    const conditions = ['t.contract IN (:contracts)', `(${type})`];
    if (selection.tokenId) conditions.push('t.token_id=:tokenId');
    if (selection.walletRequested) {
      if (selection.filter === 'purchases')
        conditions.push('t.to_address IN (:wallets)');
      else if (selection.filter === 'sales' || selection.filter === 'burns')
        conditions.push('t.from_address IN (:wallets)');
      else
        conditions.push(
          '(t.from_address IN (:wallets) OR t.to_address IN (:wallets))'
        );
    }
    if (selection.cursor)
      conditions.push(
        `(t.transaction_date < :beforeAt OR (t.transaction_date=:beforeAt AND CONCAT('t:',${eventKey}) < :beforeId))`
      );
    const rows = await this.db.execute<TransactionRow>(
      `SELECT t.*, CAST(t.token_id AS CHAR) AS exact_token_id, ${eventKey} AS event_key,
          t.transaction_date AS occurred_at, from_ens.display AS from_display, to_ens.display AS to_display
       FROM ${TRANSACTIONS_TABLE} t
       LEFT JOIN ${ENS_TABLE} from_ens ON from_ens.wallet=t.from_address
       LEFT JOIN ${ENS_TABLE} to_ens ON to_ens.wallet=t.to_address
       WHERE ${conditions.join(' AND ')}
       ORDER BY t.transaction_date DESC, event_key DESC LIMIT :rowLimit`,
      this.queryParams(selection)
    );
    return rows.map(transactionToActivity);
  }

  private async marketEvents(
    selection: ActivitySelection
  ): Promise<ApiNftActivityEvent[]> {
    const kinds = selectedMarketKinds(selection.filter);
    if (kinds?.length === 0) return [];
    const date = 'e.occurred_at';
    const conditions = [
      "e.chain_id='1'",
      'e.contract IN (:contracts)',
      'LOWER(e.kind) NOT IN (:chainKinds)'
    ];
    if (selection.tokenId) {
      const collectionMatch = selection.slugs?.length
        ? 'OR (e.token_id IS NULL AND e.collection_slug IN (:slugs))'
        : '';
      conditions.push(`(e.token_id=:tokenId ${collectionMatch})`);
    }
    if (selection.walletRequested)
      conditions.push('(e.maker IN (:wallets) OR e.taker IN (:wallets))');
    if (kinds) conditions.push('LOWER(e.kind) IN (:kinds)');
    if (selection.cursor)
      conditions.push(
        `(${date} < :beforeAt OR (${date}=:beforeAt AND CONCAT('m:',e.event_id) < :beforeId))`
      );
    const rows = await this.db.execute<MarketEventRow>(
      `SELECT e.event_id, e.kind, e.source, e.source_evidence, e.contract,
          e.token_id, e.collection_slug, e.quantity, e.maker, e.taker,
          e.price_decimal, e.currency_contract, e.currency_symbol, e.currency_decimals,
          e.order_id, e.transaction_hash, e.provider_at, e.observed_at, e.occurred_at
       FROM ${MARKET_DEPTH_EVENTS_TABLE} e
       WHERE ${conditions.join(' AND ')}
       ORDER BY occurred_at DESC, e.event_id DESC LIMIT :rowLimit`,
      { ...this.queryParams(selection), kinds, chainKinds: CHAIN_MARKET_KINDS },
      { forcePool: DbPoolName.WRITE }
    );
    return rows.map(marketEventToActivity);
  }

  private queryParams(selection: ActivitySelection) {
    return {
      contracts: selection.contracts,
      tokenId: selection.tokenId ?? null,
      wallets: selection.wallets,
      slugs: selection.slugs ?? [],
      rowLimit: selection.limit + 1,
      beforeAt: selection.cursor ? new Date(selection.cursor.at) : null,
      beforeId: selection.cursor?.id ?? null,
      zero: NULL_ADDRESS,
      dead: NULL_ADDRESS_DEAD,
      manifold: MANIFOLD
    };
  }

  private async historyStartedAt(
    contracts: readonly string[]
  ): Promise<Date | null> {
    // Match the (chain_id, contract, observed_at) index. MIN over several
    // partitions can scan the entire retained history on every feed request.
    const firstEvents = await Promise.all(
      contracts.map((contract) =>
        this.db.oneOrNull<{ started_at: Date }>(
          `SELECT observed_at AS started_at FROM ${MARKET_DEPTH_EVENTS_TABLE}
         WHERE chain_id='1' AND contract=:contract
         ORDER BY observed_at ASC LIMIT 1`,
          { contract },
          { forcePool: DbPoolName.WRITE }
        )
      )
    );
    return firstEvents.reduce<Date | null>((earliest, event) => {
      if (!event) return earliest;
      const at = new Date(event.started_at);
      return earliest === null || at < earliest ? at : earliest;
    }, null);
  }

  async getActivity(
    query: GetNftMarketActivityQuery
  ): Promise<ApiNftActivityPage> {
    const contracts = query.contract
      ? Array.from(
          new Set(
            query.contract
              .split(',')
              .map((contract) => contract.trim().toLowerCase())
          )
        )
      : MARKET_CONTRACTS;
    if (
      contracts.length > 4 ||
      contracts.some((contract) => !MARKET_CONTRACTS.includes(contract))
    ) {
      throw new BadRequestException('Unsupported market collection');
    }
    const walletInputs = query.wallet?.split(',') ?? [];
    if (walletInputs.length > 30)
      throw new BadRequestException('Use at most 30 wallets');
    const wallets = query.wallet
      ? (await resolveEns(query.wallet))
          .map((wallet) => wallet.toLowerCase())
          .filter((wallet) => ADDRESS.test(wallet))
      : [];
    const filter = query.filter ?? 'all';
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({ contracts, tokenId: query.token_id, wallets, filter })
      )
      .digest('hex');
    const cursor = query.cursor
      ? decodeMarketCursor<ActivityCursor>(query.cursor)
      : null;
    if (
      cursor &&
      (cursor.v !== 1 ||
        cursor.fingerprint !== fingerprint ||
        typeof cursor.at !== 'string' ||
        !Number.isFinite(Date.parse(cursor.at)) ||
        typeof cursor.id !== 'string' ||
        !/^[tm]:[a-f0-9]{64}$/.test(cursor.id))
    ) {
      throw new BadRequestException(
        'Invalid activity cursor for these filters'
      );
    }
    let slugs: string[] | undefined;
    if (query.token_id) {
      const token = await marketDepthApiDb.getToken(
        contracts[0],
        query.token_id
      );
      slugs = (await marketDepthApiDb.getPartitions(token)).map(
        (partition) => partition.collection_slug
      );
    }
    const selection: ActivitySelection = {
      contracts,
      tokenId: query.token_id,
      wallets,
      walletRequested: Boolean(query.wallet),
      slugs,
      filter,
      limit: query.page_size ?? 50,
      cursor
    };
    if (query.wallet && wallets.length === 0)
      return {
        data: [],
        next: null,
        market_history_started_at: null,
        notes: ACTIVITY_NOTES
      };
    const [transactions, market, history] = await Promise.all([
      this.transactionEvents(selection),
      this.marketEvents(selection),
      this.historyStartedAt(contracts)
    ]);
    const merged = [...transactions, ...market].sort(compareActivity);
    const data = merged.slice(0, selection.limit);
    const last = data.at(-1);
    return {
      data,
      next:
        merged.length > selection.limit && last
          ? encodeMarketCursor({
              v: 1,
              fingerprint,
              at: last.occurred_at.toISOString(),
              id: last.event_id
            })
          : null,
      market_history_started_at: history,
      notes: ACTIVITY_NOTES
    };
  }
}

export const nftMarketActivityService = new NftMarketActivityService(
  dbSupplier
);
