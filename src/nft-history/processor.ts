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
import { describeHistoryEdit } from './metadata';

interface PositionedRow {
  row: NFTHistory | NFTHistoryEventEntity;
  block: number;
  transaction_index: number;
  log_index: number;
  kind: 'legacy' | 'event';
}

export async function prepareHistoryWrite(
  candidate: ClaimEvent,
  snapshot: HistorySnapshot,
  describe: (
    previous: string,
    next: string
  ) => Promise<HistoryEdit | null> = describeHistoryEdit
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
    const {
      description: _description,
      created_at: _createdAt,
      ...identity
    } = existing;
    if (
      Object.keys(candidate).some(
        (key) =>
          String(candidate[key as keyof ClaimEvent]) !==
          String(identity[key as keyof ClaimEvent])
      )
    ) {
      throw new Error('Existing event differs from canonical chain event');
    }
    return plan;
  }
  const events = [
    ...snapshot.events,
    { ...candidate, created_at: new Date(), description: null }
  ];
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
    // Legacy records have no transaction/log positions. Obtain their real
    // position before choosing a predecessor, including within the same block.
    const tx = await getEthereumRpcClient().getTransaction(
      row.transaction_hash
    );
    if (!tx || tx.blockNumber !== row.block)
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
  rows.sort(compareHistoryPosition);
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
  const event = events[events.length - 1];
  event.description = await describe(previous.uri, candidate.uri);
  plan.inserts.push(event);
  // Only the next row changes predecessor. Reconcile it in the same transaction
  // so inserting an old event cannot leave a newer Edit diff pointing at Mint.
  const next = rows[index + 1];
  if (next?.row.uri) {
    if (next.kind === 'legacy' && next.row.description?.event === 'Mint')
      throw new Error(
        'Claim update precedes an existing Mint; manual reconciliation required'
      );
    const description = await describe(candidate.uri, next.row.uri);
    if (JSON.stringify(description) !== JSON.stringify(next.row.description)) {
      if (next.kind === 'event')
        plan.eventUpdates.push({
          event_id: (next.row as NFTHistoryEventEntity).event_id,
          description
        });
      else if (description)
        plan.legacyUpdates.push({
          uri: next.row.uri,
          transaction_hash: next.row.transaction_hash,
          description
        });
      else
        throw new Error(
          'Legacy edit becomes a no-op; audit its source event before replay'
        );
    }
  }
  return plan;
}
