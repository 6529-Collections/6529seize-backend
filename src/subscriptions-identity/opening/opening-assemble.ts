import {
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE
} from '@/constants';
import { compareText } from '../engine/text-order';
import {
  attributeByAddress,
  identitiesOfKey,
  openingKeys,
  WalletIdentities
} from './opening-attribution';
import { currentState } from './opening-current';
import { exactSum, scaledToDecimal } from './exact-decimal';
import { flag, LegacyTables } from './legacy-tables';
import {
  AttributionNote,
  HISTORY_FORMAT,
  HistoryFile,
  HistoryLog,
  OPENING_FORMAT,
  OpeningCut,
  OpeningFile,
  OpeningFinalRow,
  OpeningRedeemed,
  OpeningTopUp,
  serializeCanonical,
  sha256Hex
} from './opening-file';

function byFields<T>(...fields: Array<(row: T) => string | number | null>) {
  return (a: T, b: T): number => {
    for (const field of fields) {
      const x = field(a);
      const y = field(b);
      if (x !== y) {
        if (typeof x === 'number' && typeof y === 'number') {
          return x - y;
        }
        return compareText(String(x), String(y));
      }
    }
    return 0;
  };
}

export interface OpeningFiles {
  readonly opening: OpeningFile;
  readonly history: HistoryFile;
  readonly openingBytes: string;
  readonly historyBytes: string;
  readonly openingSha256: string;
  readonly historySha256: string;
}

export function openingTotals(
  file: Pick<
    OpeningFile,
    | 'keys'
    | 'balances'
    | 'modes'
    | 'choices'
    | 'topUps'
    | 'finalRows'
    | 'uploads'
    | 'redeemed'
  >
): OpeningFile['totals'] {
  return {
    keys: file.keys.length,
    identities: new Set(file.keys.map((k) => k.identityKey)).size,
    balances: file.balances.length,
    modes: file.modes.length,
    choices: file.choices.length,
    topUps: file.topUps.length,
    finalRows: file.finalRows.length,
    uploads: file.uploads.length,
    redeemedRows: file.redeemed.length,
    balanceSum: scaledToDecimal(exactSum(file.balances.map((b) => b.balance))),
    topUpSum: scaledToDecimal(exactSum(file.topUps.map((t) => t.amount))),
    redeemedCount: file.redeemed.reduce((sum, r) => sum + r.count, 0),
    redeemedValueSum: scaledToDecimal(
      exactSum(file.redeemed.map((r) => r.value))
    )
  };
}

/** Builds both files from the legacy tables and the wallets' identities. */
export function assembleOpening(
  cut: OpeningCut,
  tables: LegacyTables,
  byWallet: WalletIdentities
): OpeningFiles {
  const open = (tokenId: number | string) => Number(tokenId) > cut.maxMemeId;
  const current = currentState(cut, tables, byWallet);
  const notes: AttributionNote[] = [];

  const finalRows: OpeningFinalRow[] = tables.finalRows
    .map((r) => {
      let identityKey: string;
      if (open(r.token_id)) {
        identityKey = current.identityOf(r.consolidation_key);
      } else {
        const attributed = attributeByAddress(
          SUBSCRIPTIONS_NFTS_FINAL_TABLE,
          r.consolidation_key,
          r.airdrop_address,
          byWallet
        );
        identityKey = attributed.identityKey;
        if (attributed.note) {
          notes.push(attributed.note);
        }
      }
      return {
        id: Number(r.id),
        identityKey,
        consolidationKey: r.consolidation_key,
        contract: r.contract,
        tokenId: Number(r.token_id),
        subscribedCount: Number(r.subscribed_count),
        airdropAddress: r.airdrop_address,
        balance: Number(r.balance),
        subscribedAt: r.subscribed_at ?? null,
        phase: r.phase ?? null,
        phaseSubscriptions: Number(r.phase_subscriptions),
        phasePosition: Number(r.phase_position),
        redeemedCount: Number(r.redeemed_count),
        createdAt: r.created_at,
        updatedAt: r.updated_at
      };
    })
    .sort(byFields((r) => r.id));

  const redeemed: OpeningRedeemed[] = tables.redeemed
    .map((r) => {
      const attributed = attributeByAddress(
        SUBSCRIPTIONS_REDEEMED_TABLE,
        r.consolidation_key,
        r.address,
        byWallet
      );
      if (attributed.note) {
        notes.push(attributed.note);
      }
      return {
        identityKey: attributed.identityKey,
        consolidationKey: r.consolidation_key,
        contract: r.contract,
        tokenId: Number(r.token_id),
        address: r.address,
        transaction: r.transaction,
        transactionDate: r.transaction_date ?? null,
        value: Number(r.value),
        balanceAfter: Number(r.balance_after),
        count: Number(r.count),
        createdAt: r.created_at
      };
    })
    .sort(
      byFields(
        (r) => r.contract,
        (r) => r.tokenId,
        (r) => r.transaction,
        (r) => r.address,
        (r) => r.consolidationKey
      )
    );

  const logs: HistoryLog[] = [
    ...tables.logs.flatMap((r) =>
      identitiesOfKey(r.consolidation_key, byWallet).map((identityKey) => ({
        legacyId: Number(r.id),
        queueSequence: null,
        identityKey,
        consolidationKey: r.consolidation_key,
        log: r.log,
        additionalInfo: r.additional_info ?? null,
        createdAt: r.created_at
      }))
    ),
    ...current.queuedLogs
  ].sort(
    byFields(
      // Legacy lines first, in id order, then waiting lines in queue order.
      (r) => (r.legacyId === null ? 1 : 0),
      (r) => r.legacyId ?? r.queueSequence ?? 0,
      (r) => r.identityKey
    )
  );

  const history: HistoryFile = {
    format: HISTORY_FORMAT,
    cutAt: cut.at,
    logs,
    pastChoices: tables.choices
      .filter((r) => !open(r.token_id))
      .map((r) => ({
        consolidationKey: r.consolidation_key,
        contract: r.contract,
        tokenId: Number(r.token_id),
        subscribed: flag(r.subscribed),
        subscribedCount: Number(r.subscribed_count),
        automaticSubscription: flag(r.automatic_subscription),
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }))
      .sort(
        byFields(
          (r) => r.contract,
          (r) => r.tokenId,
          (r) => r.consolidationKey
        )
      )
  };
  const historyBytes = serializeCanonical(history);
  const historySha256 = sha256Hex(historyBytes);

  const topUps: OpeningTopUp[] = [
    ...tables.topUps.map((r) => {
      const sender = r.from_wallet.toLowerCase();
      return {
        hash: r.hash,
        block: Number(r.block),
        transactionDate: r.transaction_date,
        fromWallet: r.from_wallet,
        amount: Number(r.amount),
        identityKey: byWallet.get(sender) ?? sender,
        createdAt: r.created_at
      };
    }),
    ...current.creditedTopUps
  ].sort(
    byFields(
      (r) => r.block,
      (r) => r.hash
    )
  );
  const uploads = tables.uploads
    .map((r) => ({
      contract: r.contract,
      tokenId: Number(r.token_id),
      date: r.date,
      uploadUrl: r.upload_url,
      createdAt: r.created_at
    }))
    .sort(
      byFields(
        (r) => r.contract,
        (r) => r.tokenId
      )
    );

  const allKeys = [
    ...tables.balances.map((r) => r.consolidation_key),
    ...tables.modes.map((r) => r.consolidation_key),
    ...tables.choices.map((r) => r.consolidation_key),
    ...tables.finalRows.map((r) => r.consolidation_key),
    ...tables.redeemed.map((r) => r.consolidation_key),
    ...tables.logs.map((r) => r.consolidation_key),
    // A waiting top-up the cut credits is its sender's current state under
    // the queue entry's key, which has no legacy rows when the key-width
    // guard holds every write of it back.
    ...current.queued
      .filter((q) => q.effect === 'TOP_UP_CREDITED')
      .map((q) => q.consolidationKey)
  ];
  const keys = openingKeys(allKeys, current.identityOf, byWallet);
  const attribution = Array.from(
    new Map(
      notes.map((n) => [`${n.table}|${n.consolidationKey}|${n.identityKey}`, n])
    ).values()
  ).sort(
    byFields(
      (n) => n.table,
      (n) => n.consolidationKey
    )
  );

  const sections = {
    keys,
    balances: current.balances,
    modes: current.modes,
    choices: current.choices,
    topUps,
    finalRows,
    uploads,
    redeemed
  };
  const opening: OpeningFile = {
    format: OPENING_FORMAT,
    cut,
    historySha256,
    blocked: current.blocked,
    merged: current.merged,
    queued: current.queued,
    attribution,
    ...sections,
    totals: openingTotals(sections)
  };
  const openingBytes = serializeCanonical(opening);
  return {
    opening,
    history,
    openingBytes,
    historyBytes,
    openingSha256: sha256Hex(openingBytes),
    historySha256
  };
}
