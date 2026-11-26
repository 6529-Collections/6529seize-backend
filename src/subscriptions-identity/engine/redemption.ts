import {
  MEMES_CONTRACT,
  MEMES_MINT_PRICE,
  RESEARCH_6529_ADDRESS
} from '@/constants';
import { roundSubscriptionBalance } from './parity-money';
import { PhasedFinalRow } from './phase-split';

/** A mint from the null address, one row per (transaction, recipient, token). */
export interface AirdropTransfer {
  readonly transaction: string;
  readonly block: number;
  readonly transactionDate: string | null;
  readonly to: string;
  readonly contract: string;
  readonly tokenId: number;
  readonly tokenCount: number;
}

export interface RedeemedEntry {
  readonly contract: string;
  readonly tokenId: number;
  readonly address: string;
  readonly transaction: string;
  readonly transactionDate: string | null;
  readonly key: string;
  readonly value: number;
  readonly balanceAfter: number;
  readonly count: number;
}

export type RedemptionNotice =
  | {
      readonly kind: 'NO_SUBSCRIPTION';
      readonly airdropAddress: string;
      readonly transaction: string;
    }
  | {
      readonly kind: 'NO_BALANCE' | 'INSUFFICIENT_BALANCE';
      readonly key: string;
      readonly transaction: string;
    };

export type RedemptionSkipReason =
  | 'NOT_MEMES'
  | 'RESEARCH'
  | 'DISTRIBUTION_AIRDROP';

export interface RedemptionResult {
  readonly redeemed: RedeemedEntry[];
  readonly notices: RedemptionNotice[];
  readonly skipped: ReadonlyArray<{
    readonly transaction: string;
    readonly to: string;
    readonly reason: RedemptionSkipReason;
  }>;
  readonly finalRows: PhasedFinalRow[];
  /** Every balance the run touched or read, by key. */
  readonly balances: Map<string, number>;
}

export interface RedemptionParams {
  /**
   * Every airdrop mint (from the null address, value 0, count above 0) of the
   * tokens involved, from the start. Those above `afterBlock` are processed;
   * all of them count as earlier airdrops for the distribution check.
   */
  readonly transfers: readonly AirdropTransfer[];
  readonly afterBlock: number;
  readonly finalRows: readonly PhasedFinalRow[];
  /** Balances by key before the run. A key with no entry has no row. */
  readonly balances: ReadonlyMap<string, number>;
  /**
   * The distribution table's count for a wallet in the automatic airdrop
   * phases (Airdrop, Airdrop - Artist, Airdrop - Team) of a card.
   */
  readonly distributionAirdropCount: (
    wallet: string,
    contract: string,
    tokenId: number
  ) => number;
  /**
   * The legacy check adds the earlier airdrops' SUM, which MySQL returns as a
   * DECIMAL string, to the transfer's count: "2" + 1 is "21". Parity keeps
   * that (true); false adds numbers.
   */
  readonly legacyDecimalConcat?: boolean;
  readonly mintPrice?: number;
}

function lower(value: string): string {
  return value.toLowerCase();
}

function compareTransfers(a: AirdropTransfer, b: AirdropTransfer): number {
  if (a.block !== b.block) {
    return a.block - b.block;
  }
  if (a.transaction !== b.transaction) {
    return a.transaction < b.transaction ? -1 : 1;
  }
  if (a.to !== b.to) {
    return a.to < b.to ? -1 : 1;
  }
  return a.tokenId - b.tokenId;
}

/**
 * MySQL ascending order as used here: NULL first, then lowercase text. The
 * column's collation also folds accents and has its own weights, so this is
 * an approximation; the phase names in use (Phase 0 to 2, Public) order the
 * same under both.
 */
function comparePhase(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return -1;
  }
  if (b === null) {
    return 1;
  }
  const la = lower(a);
  const lb = lower(b);
  if (la === lb) {
    return 0;
  }
  return la < lb ? -1 : 1;
}

function earlierAirdropSum(
  transfers: readonly AirdropTransfer[],
  transfer: AirdropTransfer
): number | null {
  const earlier = transfers.filter(
    (t) =>
      lower(t.contract) === lower(transfer.contract) &&
      t.tokenId === transfer.tokenId &&
      lower(t.to) === lower(transfer.to) &&
      t.block < transfer.block
  );
  if (earlier.length === 0) {
    return null;
  }
  return earlier.reduce((sum, t) => sum + t.tokenCount, 0);
}

function distributionThreshold(
  previous: number | null,
  tokenCount: number,
  legacyDecimalConcat: boolean
): number {
  if (previous === null) {
    return tokenCount;
  }
  if (legacyDecimalConcat) {
    return Number(`${previous}${tokenCount}`);
  }
  return previous + tokenCount;
}

function skipReason(
  transfer: AirdropTransfer,
  params: RedemptionParams,
  legacyDecimalConcat: boolean
): RedemptionSkipReason | null {
  if (lower(transfer.contract) !== lower(MEMES_CONTRACT)) {
    return 'NOT_MEMES';
  }
  if (lower(transfer.to) === lower(RESEARCH_6529_ADDRESS)) {
    return 'RESEARCH';
  }
  const distributionCount = params.distributionAirdropCount(
    lower(transfer.to),
    lower(transfer.contract),
    transfer.tokenId
  );
  if (distributionCount > 0) {
    const threshold = distributionThreshold(
      earlierAirdropSum(params.transfers, transfer),
      transfer.tokenCount,
      legacyDecimalConcat
    );
    if (distributionCount >= threshold) {
      return 'DISTRIBUTION_AIRDROP';
    }
  }
  return null;
}

interface MutableRow {
  row: PhasedFinalRow;
  redeemedCount: number;
}

function findRow(
  rows: readonly MutableRow[],
  transfer: AirdropTransfer
): MutableRow | undefined {
  return rows
    .filter(
      (r) =>
        lower(r.row.contract) === lower(transfer.contract) &&
        r.row.tokenId === transfer.tokenId &&
        r.row.airdropAddress !== null &&
        lower(r.row.airdropAddress) === lower(transfer.to) &&
        r.redeemedCount < r.row.subscribedCount
    )
    .sort((a, b) => {
      const byPhase = comparePhase(a.row.phase, b.row.phase);
      return byPhase === 0
        ? a.row.phasePosition - b.row.phasePosition
        : byPhase;
    })[0];
}

/**
 * Matches airdrop mints to final subscriptions and charges the mint price,
 * by the legacy redemption loop's rules (transactionsProcessingLoop
 * subscriptions.ts). Pure: no notifications are sent; they are returned.
 *
 * Transfers in one block are processed by transaction hash, then recipient;
 * the legacy loop uses the database's order there.
 */
export function matchRedemptions(params: RedemptionParams): RedemptionResult {
  const mintPrice = params.mintPrice ?? MEMES_MINT_PRICE;
  const legacyDecimalConcat = params.legacyDecimalConcat ?? true;
  const rows: MutableRow[] = params.finalRows.map((row) => ({
    row,
    redeemedCount: row.redeemedCount
  }));
  const balances = new Map<string, number>(
    Array.from(params.balances.entries()).map(([k, v]) => [lower(k), v])
  );
  const redeemed = new Map<string, RedeemedEntry>();
  const notices: RedemptionNotice[] = [];
  const skipped: {
    transaction: string;
    to: string;
    reason: RedemptionSkipReason;
  }[] = [];

  const toProcess = params.transfers
    .filter((t) => t.block > params.afterBlock && t.tokenCount > 0)
    .slice()
    .sort(compareTransfers);

  for (const transfer of toProcess) {
    const reason = skipReason(transfer, params, legacyDecimalConcat);
    if (reason) {
      skipped.push({
        transaction: transfer.transaction,
        to: transfer.to,
        reason
      });
      continue;
    }
    for (let i = 0; i < transfer.tokenCount; i++) {
      const match = findRow(rows, transfer);
      if (!match) {
        notices.push({
          kind: 'NO_SUBSCRIPTION',
          airdropAddress: transfer.to,
          transaction: transfer.transaction
        });
        continue;
      }
      const key = lower(match.row.key);
      let balance = balances.get(key);
      if (balance === undefined) {
        notices.push({
          kind: 'NO_BALANCE',
          key,
          transaction: transfer.transaction
        });
        balance = 0;
      } else if (mintPrice > balance) {
        notices.push({
          kind: 'INSUFFICIENT_BALANCE',
          key,
          transaction: transfer.transaction
        });
      }
      const balanceAfter = roundSubscriptionBalance(balance - mintPrice);
      balances.set(key, balanceAfter);

      const entryKey = [
        lower(transfer.contract),
        transfer.tokenId,
        lower(transfer.to),
        lower(transfer.transaction),
        key
      ].join('|');
      const existing = redeemed.get(entryKey);
      redeemed.set(
        entryKey,
        existing
          ? {
              ...existing,
              value: existing.value + mintPrice,
              count: existing.count + 1,
              balanceAfter
            }
          : {
              contract: transfer.contract,
              tokenId: transfer.tokenId,
              address: transfer.to,
              transaction: transfer.transaction,
              transactionDate: transfer.transactionDate,
              key,
              value: mintPrice,
              balanceAfter,
              count: 1
            }
      );
      match.redeemedCount++;
    }
  }

  return {
    redeemed: Array.from(redeemed.values()),
    notices,
    skipped,
    finalRows: rows.map((r) => ({ ...r.row, redeemedCount: r.redeemedCount })),
    balances
  };
}
