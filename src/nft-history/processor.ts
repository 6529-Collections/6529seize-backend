import { NFTHistory } from '@/entities/INFTHistory';
import {
  HistoryEdit,
  NFTHistoryEventEntity
} from '@/entities/INFTHistoryEvent';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { ClaimEvent, compareHistoryPosition } from './claim-events';
import {
  HistorySnapshot,
  HistoryWritePlan,
  historyFingerprint
} from './history.db';
import { canonicalJson } from './canonical-json';
import { describeHistoryEdit } from './metadata';

type Describe = (previous: string, next: string) => Promise<HistoryEdit | null>;
interface PositionedRow {
  row: NFTHistory | NFTHistoryEventEntity;
  block: number;
  transaction_index: number;
  log_index: number;
  kind: 'legacy' | 'event';
}

async function positionHistory(
  snapshot: HistorySnapshot,
  events: NFTHistoryEventEntity[]
): Promise<PositionedRow[]> {
  const rows: PositionedRow[] = events.map((row) => ({
    row,
    block: row.block,
    transaction_index: row.transaction_index,
    log_index: row.log_index,
    kind: 'event'
  }));
  for (const row of snapshot.legacy) {
    if (
      events.some(
        (event) =>
          event.transaction_hash.toLowerCase() ===
          row.transaction_hash.toLowerCase()
      )
    )
      continue;
    // Legacy records have no transaction/log positions. Resolve their actual
    // transaction position before choosing a predecessor within the same block.
    const tx = await getEthereumRpcClient().getTransaction(
      row.transaction_hash
    );
    if (tx?.blockNumber !== row.block)
      throw new Error(
        `Cannot position legacy history: ${row.transaction_hash}`
      );
    rows.push({
      row,
      block: row.block,
      transaction_index: tx.index,
      log_index: -1,
      kind: 'legacy'
    });
  }
  return rows.sort(compareHistoryPosition);
}

async function reconcileSuccessor(
  plan: HistoryWritePlan,
  next: PositionedRow | undefined,
  uri: string,
  describe: Describe
): Promise<void> {
  if (!next?.row.uri) return;
  if (next.kind === 'legacy' && next.row.description?.event === 'Mint')
    throw new Error(
      'Claim update precedes an existing Mint; manual reconciliation required'
    );
  const description = await describe(uri, next.row.uri);
  if (canonicalJson(description) === canonicalJson(next.row.description))
    return;
  if (next.kind === 'event') {
    plan.eventUpdates.push({
      event_id: (next.row as NFTHistoryEventEntity).event_id,
      description
    });
    return;
  }
  if (!description)
    throw new Error(
      'Legacy edit becomes a no-op; audit its source event before replay'
    );
  plan.legacyUpdates.push({
    uri: next.row.uri,
    transaction_hash: next.row.transaction_hash,
    description
  });
}

export async function prepareHistoryWrite(
  candidate: ClaimEvent,
  snapshot: HistorySnapshot,
  describe: Describe = describeHistoryEdit
): Promise<HistoryWritePlan> {
  const plan: HistoryWritePlan = {
    contract: candidate.contract,
    nft_id: candidate.nft_id,
    before: historyFingerprint(snapshot),
    inserts: [],
    eventUpdates: [],
    legacyUpdates: []
  };
  const existing = snapshot.events.find(
    (row) => row.event_id === candidate.event_id
  );
  if (existing) {
    if (
      Object.keys(candidate).some(
        (key) =>
          String(candidate[key as keyof ClaimEvent]) !==
          String(existing[key as keyof ClaimEvent])
      )
    )
      throw new Error('Existing event differs from canonical chain event');
    return plan;
  }
  const event: NFTHistoryEventEntity = {
    ...candidate,
    created_at: new Date(),
    description: null
  };
  const rows = await positionHistory(snapshot, [...snapshot.events, event]);
  const index = rows.findIndex(
    (entry) =>
      entry.kind === 'event' &&
      (entry.row as NFTHistoryEventEntity).event_id === candidate.event_id
  );
  const previous = rows[index - 1]?.row;
  if (!previous?.uri)
    throw new Error(
      'Missing predecessor metadata; mint baseline must be verified first'
    );
  plan.previous_uri = previous.uri;
  event.description = await describe(previous.uri, candidate.uri);
  plan.inserts.push(event);
  // Only the next row changes predecessor; reconcile it in the same transaction.
  await reconcileSuccessor(plan, rows[index + 1], candidate.uri, describe);
  return plan;
}
