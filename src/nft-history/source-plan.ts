import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { NFTHistory } from '@/entities/INFTHistory';
import { canonicalJson, historyDigest } from './canonical-json';
import {
  HistorySnapshot,
  HistoryWritePlan,
  historyFingerprint
} from './history.db';
import { prepareHistoryWrite } from './processor';
import { applyVirtualPlan, planReceipt } from './replay-manifest';
import { HistorySourceOperation, SourceClaim } from './source-operations';

export interface StoredSourceClaim {
  contract: string;
  claimIndex: string | number;
  location: string;
  nft_id?: number;
}
export interface SourceReader {
  history(contract: string, tokenId: number): Promise<HistorySnapshot>;
  claims(contract: string, claimId: string): Promise<StoredSourceClaim[]>;
}
export interface HistorySourcePlan {
  claims: { before: string; record: SourceClaim }[];
  writes: (
    | { kind: 'mint'; before: string; row: NFTHistory }
    | { kind: 'edit'; plan: HistoryWritePlan }
  )[];
}

export function hasMint(snapshot: HistorySnapshot): boolean {
  return snapshot.legacy.some((row) => row.description?.event === 'Mint');
}

export function claimFingerprint(rows: StoredSourceClaim[]): string {
  return historyDigest(
    rows
      .map((row) =>
        canonicalJson([
          row.contract.toLowerCase(),
          String(row.claimIndex),
          row.location,
          Number(row.nft_id)
        ])
      )
      .sort((a, b) => a.localeCompare(b))
  );
}

export class VirtualSourceReader implements SourceReader {
  private readonly histories = new Map<string, HistorySnapshot>();
  private readonly mappings = new Map<string, StoredSourceClaim[]>();
  constructor(private readonly base: SourceReader) {}

  async history(contract: string, tokenId: number): Promise<HistorySnapshot> {
    const key = `${contract.toLowerCase()}:${tokenId}`;
    let value = this.histories.get(key);
    if (!value) {
      value = await this.base.history(contract, tokenId);
      this.histories.set(key, value);
    }
    return value;
  }

  async claims(
    contract: string,
    claimId: string
  ): Promise<StoredSourceClaim[]> {
    const key = `${contract.toLowerCase()}:${claimId}`;
    let value = this.mappings.get(key);
    if (!value) {
      value = await this.base.claims(contract, claimId);
      this.mappings.set(key, value);
    }
    return value;
  }

  async apply(plan: HistorySourcePlan): Promise<void> {
    for (const { record } of plan.claims) {
      const rows = await this.claims(record.contract, record.claimId);
      const next = rows.filter((row) => row.location !== record.location);
      next.push({
        contract: record.contract,
        claimIndex: record.claimId,
        location: record.location,
        nft_id: record.tokenId
      });
      this.mappings.set(
        `${record.contract.toLowerCase()}:${record.claimId}`,
        next
      );
    }
    for (const write of plan.writes) {
      const contract =
        write.kind === 'mint' ? write.row.contract : write.plan.contract;
      const tokenId =
        write.kind === 'mint' ? write.row.nft_id : write.plan.nft_id;
      const current = await this.history(contract, tokenId);
      this.histories.set(
        `${contract.toLowerCase()}:${tokenId}`,
        write.kind === 'mint'
          ? { legacy: [...current.legacy, write.row], events: current.events }
          : applyVirtualPlan(current, write.plan)
      );
    }
  }
}

function emptyPlan(): HistorySourcePlan {
  return { claims: [], writes: [] };
}

async function mappingStep(
  record: SourceClaim,
  view: SourceReader
): Promise<HistorySourcePlan> {
  if (
    !/^\d+$/.test(record.claimId) ||
    BigInt(record.claimId) > BigInt('9223372036854775807') ||
    record.location.length > 100
  )
    throw new Error('Claim mapping exceeds the existing storage bounds');
  const rows = await view.claims(record.contract, record.claimId);
  const sameKey = rows.find((row) => row.location === record.location);
  if (
    sameKey &&
    Number(sameKey.nft_id) >= 0 &&
    Number(sameKey.nft_id) !== record.tokenId
  )
    throw new Error('Existing claim mapping conflicts with verified source');
  const plan = emptyPlan();
  if (!sameKey || Number(sameKey.nft_id) !== record.tokenId)
    plan.claims.push({ before: claimFingerprint(rows), record });
  return plan;
}

async function mintStep(
  row: NFTHistory,
  view: SourceReader
): Promise<HistorySourcePlan> {
  if (!row.uri || row.uri.length > 100)
    throw new Error('Mint URI exceeds the existing history storage bounds');
  const snapshot = await view.history(row.contract, row.nft_id);
  const plan = emptyPlan();
  if (hasMint(snapshot)) return plan;
  if (
    snapshot.legacy.length ||
    snapshot.events.some((event) => event.description !== null)
  )
    throw new Error(
      'History exists without a verified Mint baseline; reconcile explicitly'
    );
  plan.writes.push({ kind: 'mint', before: historyFingerprint(snapshot), row });
  return plan;
}

async function beforeRecordedMint(
  event: Extract<HistorySourceOperation, { kind: 'edit' }>['event'],
  mint?: NFTHistory
): Promise<boolean> {
  if (!mint) return true;
  if (event.block !== mint.block) return event.block < mint.block;
  const tx = await getEthereumRpcClient().getTransaction(mint.transaction_hash);
  if (!tx || tx.blockNumber !== mint.block)
    throw new Error('Cannot position recorded Mint');
  return event.transaction_index < tx.index;
}

async function editStep(
  operation: Extract<HistorySourceOperation, { kind: 'edit' }>,
  view: SourceReader
): Promise<HistorySourcePlan> {
  const { event } = operation;
  const snapshot = await view.history(event.contract, event.nft_id);
  const mint = snapshot.legacy
    .filter((row) => row.description?.event === 'Mint')
    .sort((a, b) => a.block - b.block)[0];
  const plan = emptyPlan();
  if (operation.beforeFirstMint && (await beforeRecordedMint(event, mint))) {
    const existing = snapshot.events.find(
      (row) => row.event_id === event.event_id
    );
    if (existing) {
      await prepareHistoryWrite(event, snapshot);
      if (existing.description !== null)
        throw new Error('Existing pre-Mint event is visible');
      return plan;
    }
    plan.writes.push({
      kind: 'edit',
      plan: {
        contract: event.contract,
        nft_id: event.nft_id,
        before: historyFingerprint(snapshot),
        inserts: [{ ...event, created_at: new Date(), description: null }],
        eventUpdates: [],
        legacyUpdates: []
      }
    });
    return plan;
  }
  if (!mint)
    throw new Error(
      'Mint baseline missing; replay initialization and first mint first'
    );
  const edit = await prepareHistoryWrite(event, snapshot);
  if (
    edit.inserts.length ||
    edit.eventUpdates.length ||
    edit.legacyUpdates.length
  )
    plan.writes.push({ kind: 'edit', plan: edit });
  return plan;
}

export async function prepareSourcePlan(
  operations: HistorySourceOperation[],
  reader: SourceReader,
  remainingMillis: () => number = () => 900000
): Promise<HistorySourcePlan> {
  const plan = emptyPlan();
  const view = new VirtualSourceReader(reader);
  for (const operation of operations) {
    if (remainingMillis() < 90000)
      throw new Error('Source planning time budget exhausted');
    let step: HistorySourcePlan;
    if (operation.kind === 'claim')
      step = await mappingStep(operation.claim, view);
    else if (operation.kind === 'mint')
      step = await mintStep(operation.row, view);
    else step = await editStep(operation, view);
    await view.apply(step);
    plan.claims.push(...step.claims);
    plan.writes.push(...step.writes);
  }
  return plan;
}

export function sourcePlanReceipt(plan: HistorySourcePlan) {
  return {
    claims: plan.claims,
    writes: plan.writes.map((write) => {
      if (write.kind === 'edit')
        return { kind: write.kind, plan: planReceipt(write.plan) };
      const { created_at: _createdAt, ...row } = write.row;
      return { kind: write.kind, before: write.before, row };
    })
  };
}
