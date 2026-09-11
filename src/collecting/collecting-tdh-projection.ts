import {
  collectingAssetKey,
  collectingHash
} from '@/collecting/collecting-analysis';
import {
  CollectingAccount,
  CollectingFamily
} from '@/collecting/collecting.types';
import { MemesSeason } from '@/entities/ISeason';
import { TokenTDH } from '@/entities/ITDH';
import { Transaction } from '@/entities/ITransaction';
import { BadRequestException, CustomApiCompliantException } from '@/exceptions';
import { isAddress } from 'ethers';
import { calculateBoost, getGenesisAndNaka, getTokenTdh } from '@/tdhLoop/tdh';
import { consolidateCards } from '@/tdhLoop/tdh_consolidation';
import { getAdjustedSeasons } from '@/tdhLoop/tdh-rules';

export interface CollectingProjectionToken {
  contract: string;
  token_id: number;
  family: CollectingFamily;
  minted_at: string;
  hodl_rate: number;
  /** Canonical max(actual mint supply, edition floor), including production adjustments. */
  calculation_edition_size?: number;
}

export interface CollectingHypotheticalTransfer {
  contract: string;
  token_id: number;
  from_address: string;
  to_address: string;
  quantity: number;
  timestamp: string;
}

export interface CollectingTdhProjectionInput {
  snapshot_block: number;
  snapshot_timestamp: string;
  rules_version: string;
  wallets: string[];
  tokens: CollectingProjectionToken[];
  seasons: MemesSeason[];
  transactions: Transaction[];
  evaluated_at: string;
  transfers: CollectingHypotheticalTransfer[];
}

export interface CollectingTdhProjectionRequest {
  profile_id: string;
  evaluated_at: string;
  transfers: CollectingHypotheticalTransfer[];
}

export interface CollectingPurchaseProjectionRequest {
  profile_id: string;
  horizon_days: 1 | 30 | 90 | 365;
  acquisitions: Array<{
    asset_key: string;
    quantity: string;
    recipient: string;
  }>;
}

export interface CollectingOfficialTdh {
  base_tdh: number;
  boosted_tdh: number;
  boost: number;
  full_memes_sets: number;
  tokens?: ProjectedToken[];
}

export interface CollectingTdhSource {
  account: CollectingAccount;
  input: CollectingTdhProjectionInput;
  official: CollectingOfficialTdh;
}

export interface ProjectedToken {
  asset_key: string;
  family: CollectingFamily;
  balance: number;
  raw_days_held: number;
  hodl_rate: number;
  base_tdh: number;
  boosted_tdh: number;
}

export interface ProjectedAccountTdh {
  base_tdh: number;
  boosted_tdh: number;
  boost: number;
  full_memes_sets: number;
  tokens: ProjectedToken[];
  boost_breakdown: ReturnType<typeof calculateBoost>['breakdown'];
}

export interface CollectingTdhProjection {
  scenario_id: string;
  snapshot_block: number;
  snapshot_timestamp: string;
  evaluated_at: string;
  rules_version: string;
  baseline: ProjectedAccountTdh;
  proposed: ProjectedAccountTdh;
  additional_tdh: number;
  additional_base_tdh: number;
  changed_boost_on_existing_holdings: number;
  assumptions: string[];
}

function timestamp(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()))
    throw new BadRequestException('Invalid TDH scenario timestamp');
  return parsed;
}

/** Match the repository SQL executor's JSON serialization boundary. The legacy
 * TDH replay declares Date fields but parses their serialized UTC strings. */
export function toTdhReplayTransaction(transaction: Transaction): Transaction {
  return JSON.parse(JSON.stringify(transaction)) as Transaction;
}

function validateInput(input: CollectingTdhProjectionInput): Date {
  const evaluation = timestamp(input.evaluated_at);
  const snapshot = timestamp(input.snapshot_timestamp);
  if (
    !Number.isSafeInteger(input.snapshot_block) ||
    input.snapshot_block < 1 ||
    !input.rules_version
  )
    throw new BadRequestException('TDH source snapshot is required');
  if (
    evaluation < snapshot ||
    evaluation.getTime() - snapshot.getTime() > 366 * 86400000
  )
    throw new BadRequestException(
      'Projection horizon must be within 366 days of the snapshot'
    );
  if (
    !input.wallets.length ||
    input.wallets.length > 20 ||
    input.tokens.length > 50000 ||
    input.transactions.length > 100000 ||
    input.transfers.length > 2000
  )
    throw new BadRequestException('TDH scenario exceeds supported bounds');
  if (
    new Set(input.wallets.map((wallet) => wallet.toLowerCase())).size !==
    input.wallets.length
  )
    throw new BadRequestException('Duplicate account wallets');
  if (input.wallets.some((wallet) => !isAddress(wallet)))
    throw new BadRequestException('Invalid account wallet');
  const assets = new Set<string>();
  for (const token of input.tokens) {
    const key = collectingAssetKey(token.contract, String(token.token_id));
    if (
      !Number.isSafeInteger(token.token_id) ||
      token.token_id < 0 ||
      assets.has(key) ||
      !Number.isFinite(token.hodl_rate) ||
      token.hodl_rate < 0
    )
      throw new BadRequestException('Invalid projection token');
    assets.add(key);
    timestamp(token.minted_at);
    if (
      token.family === 'memes' &&
      (!Number.isSafeInteger(token.calculation_edition_size) ||
        token.calculation_edition_size! <= 0)
    )
      throw new BadRequestException(
        'Canonical Meme calculation edition size is required'
      );
  }
  for (const transfer of input.transfers) {
    const at = timestamp(transfer.timestamp);
    if (
      at < snapshot ||
      at > evaluation ||
      !Number.isSafeInteger(transfer.quantity) ||
      transfer.quantity < 1 ||
      transfer.quantity > 9999 ||
      !isAddress(transfer.from_address) ||
      !isAddress(transfer.to_address) ||
      !assets.has(
        collectingAssetKey(transfer.contract, String(transfer.token_id))
      )
    )
      throw new BadRequestException('Invalid hypothetical transfer');
  }
  let replayWork = 0;
  for (const transaction of input.transactions) {
    const date = new Date(transaction.transaction_date).getTime();
    if (
      !Number.isFinite(date) ||
      date > snapshot.getTime() ||
      transaction.block > input.snapshot_block ||
      !Number.isSafeInteger(transaction.token_count) ||
      transaction.token_count < 1 ||
      transaction.token_count > 100000
    ) {
      throw new BadRequestException(
        'Transaction history is outside the source snapshot'
      );
    }
    replayWork += transaction.token_count + 1;
  }
  if (replayWork * input.wallets.length > 2000000)
    throw new BadRequestException('TDH replay exceeds supported work bounds');
  return evaluation;
}

function validateTransferInventory(input: CollectingTdhProjectionInput): void {
  const wallets = input.wallets.map((wallet) => wallet.toLowerCase());
  const known = new Set(wallets);
  const byAsset = tokenTransactions(input.transactions);
  const tokens = new Map(
    input.tokens.map((token) => [
      collectingAssetKey(token.contract, String(token.token_id)),
      token
    ])
  );
  const transfers = input.transfers
    .slice()
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  let replayWork = 0;
  transfers.forEach((transfer, index) => {
    const key = collectingAssetKey(
      transfer.contract,
      String(transfer.token_id)
    );
    const token = tokens.get(key)!;
    const history = byAsset.get(key) ?? [];
    const at = timestamp(transfer.timestamp);
    if (at < timestamp(token.minted_at))
      throw new BadRequestException(
        'Hypothetical transfer precedes token mint'
      );
    replayWork += history.length * wallets.length;
    if (replayWork > 2000000)
      throw new BadRequestException('TDH scenario exceeds replay work bounds');
    const fromAccount = known.has(transfer.from_address.toLowerCase());
    const balance = (wallet: string) =>
      getTokenTdh(
        at,
        token.token_id,
        1,
        wallet,
        wallets,
        history.map(toTdhReplayTransaction)
      )?.balance ?? 0;
    if (token.family !== 'memes' && transfer.quantity !== 1)
      throw new BadRequestException('Unique NFT transfer quantity must be one');
    if (
      fromAccount &&
      balance(transfer.from_address.toLowerCase()) < transfer.quantity
    )
      throw new BadRequestException(
        'Hypothetical transfer exceeds custody inventory'
      );
    if (
      !fromAccount &&
      known.has(transfer.to_address.toLowerCase()) &&
      token.family !== 'memes' &&
      wallets.some((wallet) => balance(wallet) > 0)
    )
      throw new BadRequestException('Account already owns this unique NFT');
    history.push(hypotheticalTransaction(transfer, index));
    byAsset.set(key, history);
  });
}

function hypotheticalTransaction(
  transfer: CollectingHypotheticalTransfer,
  index: number
): Transaction {
  const at = timestamp(transfer.timestamp);
  return {
    transaction: `scenario-${index}`,
    block: 0,
    created_at: at,
    transaction_date: at,
    contract: transfer.contract,
    token_id: transfer.token_id,
    token_count: transfer.quantity,
    from_address: transfer.from_address.toLowerCase(),
    to_address: transfer.to_address.toLowerCase(),
    value: 0,
    primary_proceeds: 0,
    royalties: 0,
    gas_gwei: 0,
    gas_price: 0,
    gas_price_gwei: 0,
    gas: 0,
    eth_price_usd: 0,
    value_usd: 0,
    gas_usd: 0
  };
}

function tokenTransactions(
  transactions: Transaction[]
): Map<string, Transaction[]> {
  const byAsset = new Map<string, Transaction[]>();
  for (const transaction of transactions) {
    if (
      transaction.from_address.toLowerCase() ===
      transaction.to_address.toLowerCase()
    )
      continue;
    const key = collectingAssetKey(
      transaction.contract,
      String(transaction.token_id)
    );
    const list = byAsset.get(key) ?? [];
    list.push(transaction);
    byAsset.set(key, list);
  }
  return byAsset;
}

function calculateAccount(
  input: CollectingTdhProjectionInput,
  at: Date,
  transactions: Transaction[]
): ProjectedAccountTdh {
  const wallets = input.wallets.map((wallet) => wallet.toLowerCase());
  const eligible = input.tokens.filter(
    (token) =>
      timestamp(token.minted_at).getTime() <=
      at.getTime() - (token.family === 'pebbles' ? 0 : 86400000)
  );
  const memes = eligible.filter((token) => token.family === 'memes');
  const index = Math.max(
    0,
    ...memes.map((token) => token.calculation_edition_size!)
  );
  const seasons = getAdjustedSeasons(input.seasons, memes.length);
  const byAsset = tokenTransactions(
    transactions.filter(
      (transaction) =>
        new Date(transaction.transaction_date).getTime() <= at.getTime()
    )
  );
  const perFamily: Record<CollectingFamily, TokenTDH[]> = {
    memes: [],
    gradients: [],
    pebbles: []
  };
  const projected: Array<{ source: CollectingProjectionToken; tdh: TokenTDH }> =
    [];
  for (const token of eligible) {
    const key = collectingAssetKey(token.contract, String(token.token_id));
    const sourceTransactions = byAsset.get(key) ?? [];
    if (!sourceTransactions.length) continue;
    const rate =
      token.family === 'memes'
        ? index / token.calculation_edition_size!
        : token.hodl_rate;
    let consolidated: TokenTDH[] = [];
    for (const wallet of wallets) {
      // Production rounds each custody wallet before consolidating copies. Reuse
      // that order; multiplying total account days by a rate can round differently.
      const tdh = getTokenTdh(
        at,
        token.token_id,
        rate,
        wallet,
        wallets,
        sourceTransactions.map(toTdhReplayTransaction)
      );
      if (tdh) consolidated = consolidateCards(consolidated, [tdh]);
    }
    const tdh = consolidated[0];
    if (tdh) {
      perFamily[token.family].push(tdh);
      projected.push({ source: token, tdh });
    }
  }
  const fullSets =
    memes.length > 0 && perFamily.memes.length === memes.length
      ? Math.min(...perFamily.memes.map((token) => token.balance))
      : 0;
  const partials = getGenesisAndNaka(perFamily.memes);
  const boost = calculateBoost(
    seasons,
    fullSets,
    { genesis: partials.genesis, nakamoto: partials.naka },
    perFamily.memes,
    perFamily.gradients
  );
  const tokens: ProjectedToken[] = projected
    .map(({ source, tdh }) => ({
      asset_key: collectingAssetKey(source.contract, String(source.token_id)),
      family: source.family,
      balance: tdh.balance,
      raw_days_held: tdh.tdh__raw,
      hodl_rate: tdh.hodl_rate,
      base_tdh: tdh.tdh,
      boosted_tdh: Math.round(tdh.tdh * boost.total)
    }))
    .sort((a, b) => a.asset_key.localeCompare(b.asset_key));
  return {
    base_tdh: tokens.reduce((sum, token) => sum + token.base_tdh, 0),
    boosted_tdh: tokens.reduce((sum, token) => sum + token.boosted_tdh, 0),
    boost: boost.total,
    full_memes_sets: fullSets,
    tokens,
    boost_breakdown: boost.breakdown
  };
}

export function projectCollectingTdh(
  input: CollectingTdhProjectionInput
): CollectingTdhProjection {
  return createCollectingTdhProjector(input)(input.transfers);
}

/** Reuse the same source and future baseline while comparing candidate baskets. */
export function createCollectingTdhProjector(
  source: CollectingTdhProjectionInput
) {
  const base = { ...source, transfers: [] };
  const evaluation = validateInput(base);
  const baseline = calculateAccount(base, evaluation, base.transactions);
  return (
    transfers: CollectingHypotheticalTransfer[]
  ): CollectingTdhProjection => {
    const input = { ...base, transfers };
    validateInput(input);
    validateTransferInventory(input);
    const proposed = transfers.length
      ? calculateAccount(
          input,
          evaluation,
          input.transactions.concat(transfers.map(hypotheticalTransaction))
        )
      : baseline;
    return projectionResult(input, evaluation, baseline, proposed);
  };
}

function projectionResult(
  input: CollectingTdhProjectionInput,
  evaluation: Date,
  baseline: ProjectedAccountTdh,
  proposed: ProjectedAccountTdh
): CollectingTdhProjection {
  // Isolate the multiplier effect on baseline holdings. Any transfer-related loss
  // or new lot accrual remains in the rest of the total delta, not in this component.
  const existingBoostEffect = baseline.tokens.reduce(
    (sum, token) =>
      sum + Math.round(token.base_tdh * proposed.boost) - token.boosted_tdh,
    0
  );
  const result = {
    snapshot_block: input.snapshot_block,
    snapshot_timestamp: input.snapshot_timestamp,
    evaluated_at: evaluation.toISOString(),
    rules_version: input.rules_version,
    baseline,
    proposed,
    additional_tdh: proposed.boosted_tdh - baseline.boosted_tdh,
    additional_base_tdh: proposed.base_tdh - baseline.base_tdh,
    changed_boost_on_existing_holdings: existingBoostEffect,
    assumptions: [
      'Known catalog and supply inputs are frozen at the source snapshot.',
      'Confirmed account membership and rules remain unchanged.',
      'Only the explicitly supplied transfers occur.',
      'This scenario does not update official TDH.'
    ]
  };
  return { scenario_id: collectingHash(result), ...result };
}

/** Fail closed when source history, membership, catalog or rules cannot reproduce
 * the published snapshot. Forecasts never replace the official daily TDH record. */
export function assertCollectingTdhParity(
  input: CollectingTdhProjectionInput,
  official: CollectingOfficialTdh
): void {
  const source = {
    ...input,
    evaluated_at: input.snapshot_timestamp,
    transfers: []
  };
  const atSnapshot = calculateAccount(
    source,
    validateInput(source),
    source.transactions
  );
  if (
    atSnapshot.base_tdh !== official.base_tdh ||
    atSnapshot.boosted_tdh !== official.boosted_tdh ||
    atSnapshot.boost !== official.boost ||
    atSnapshot.full_memes_sets !== official.full_memes_sets ||
    (official.tokens !== undefined &&
      collectingHash(atSnapshot.tokens) !==
        collectingHash(
          official.tokens
            .slice()
            .sort((a, b) => a.asset_key.localeCompare(b.asset_key))
        ))
  ) {
    throw new CustomApiCompliantException(
      503,
      'TDH source data does not reproduce the official snapshot'
    );
  }
}
