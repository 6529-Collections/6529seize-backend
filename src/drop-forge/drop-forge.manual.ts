import { TransactionDescription } from 'ethers';
import {
  claimAbi,
  LaunchChain,
  ChainReceipt
} from '@/drop-forge/drop-forge.chain';
import {
  LaunchRecord,
  LaunchSafetyError,
  LaunchAction
} from '@/drop-forge/drop-forge.types';
import { reportActionSkip } from '@/drop-forge/drop-forge.groups';
import { addLaunchEvent } from '@/drop-forge/drop-forge.repository';
import { DropForgeConfig } from '@/drop-forge/drop-forge.config';
import {
  creditManualResearch,
  isResearchAirdrop
} from '@/drop-forge/drop-forge.research';

function matchesManualAction(
  label: string | undefined,
  phase: number,
  hint: string | undefined
): boolean {
  if (!hint) return true;
  if (hint === 'ARTIST_AIRDROP') return label === 'Airdrop - Artist';
  if (hint === 'TEAM_AIRDROP') return label === 'Airdrop - Team';
  if (hint === 'PUBLIC_PHASE_AIRDROP')
    return phase === 2 || label?.toLowerCase().includes('public') === true;
  const index = /^PHASE([012])_AIRDROP$/.exec(hint)?.[1];
  return (
    index !== undefined &&
    phase === Number(index) &&
    label?.includes('Subscription') === true
  );
}
function manualAllocationAvailable(action: LaunchAction): boolean {
  return (
    action.state === 'PENDING' ||
    (['FAILED', 'CANCELLED'].includes(action.state) &&
      !!action.recovery?.outcome &&
      action.recovery.outcome !== 'EXECUTED')
  );
}

type ManualProof = NonNullable<
  LaunchRecord['data']['manual_transactions']
>[number];

async function assertRecoveryCanonical(
  record: LaunchRecord,
  chain: LaunchChain,
  config: DropForgeConfig
): Promise<void> {
  for (const action of record.data.actions.filter(manualAllocationAvailable)) {
    if (!action.recovery?.outcome) continue;
    const winner = await chain.receipt(action.recovery.winner_hash!);
    if (
      !winner ||
      winner.blockHash !== action.recovery.block_hash ||
      winner.confirmations < config.confirmations
    )
      throw new LaunchSafetyError(
        'Recovery nonce settlement is no longer canonical; manual credits are prohibited'
      );
  }
}

async function assertLatestManualCanonical(
  record: LaunchRecord,
  chain: LaunchChain,
  config: DropForgeConfig
): Promise<void> {
  const latest = [...(record.data.manual_transactions ?? [])]
    .filter((it) => it.state === 'CONFIRMED' || it.state === 'FAILED')
    .sort((a, b) => (b.block_number ?? 0) - (a.block_number ?? 0))[0];
  if (!latest) return;
  const receipt = await chain.receipt(latest.hash);
  if (
    receipt?.status !== (latest.state === 'FAILED' ? 0 : 1) ||
    receipt.blockHash !== latest.block_hash ||
    receipt.confirmations < config.confirmations
  )
    throw new LaunchSafetyError(
      'A confirmed manual transaction is no longer canonical'
    );
}

function manualAllocations(
  decoded: TransactionDescription,
  message: string
): Map<string, number> {
  const allocations = new Map<string, number>();
  const amounts = decoded.args[3] as bigint[];
  (decoded.args[2] as string[]).forEach((address, index) => {
    const amount = Number(amounts[index]);
    if (!Number.isSafeInteger(amount) || amount <= 0)
      throw new LaunchSafetyError(message);
    const key = address.toLowerCase();
    allocations.set(key, (allocations.get(key) ?? 0) + amount);
  });
  return allocations;
}

function availableAirdrops(record: LaunchRecord): LaunchAction[] {
  return record.data.actions.filter(
    (it) =>
      it.kind === 'AIRDROP' &&
      !isResearchAirdrop(it) &&
      manualAllocationAvailable(it)
  );
}

function assertUnambiguousAllocations(
  actions: LaunchAction[],
  allocations: Map<string, number>
): void {
  for (const address of Array.from(allocations.keys())) {
    const categories = actions
      .filter((it) =>
        (it.remaining_recipients ?? it.recipients).some(
          (row) => row.address.toLowerCase() === address
        )
      )
      .map((it) => `${it.phase}:${it.label ?? ''}`);
    if (new Set(categories).size > 1)
      throw new LaunchSafetyError(
        'Manual airdrop category is ambiguous; declare its category before reconciliation'
      );
  }
}

function assertAvailableAllocations(
  actions: LaunchAction[],
  allocations: Map<string, number>
): void {
  const available = new Map<string, number>();
  for (const action of actions) {
    for (const row of action.remaining_recipients ?? action.recipients) {
      const address = row.address.toLowerCase();
      available.set(address, (available.get(address) ?? 0) + row.amount);
    }
  }
  if (
    Array.from(allocations).some(
      ([address, amount]) => amount > (available.get(address) ?? 0)
    )
  )
    throw new LaunchSafetyError(
      'Manual airdrop exceeds remaining planned allocations; review before resuming'
    );
}

function creditAction(
  record: LaunchRecord,
  action: LaunchAction,
  allocations: Map<string, number>,
  proof: ManualProof,
  receipt: ChainReceipt
): void {
  const creditedBefore = action.credited_tokens ?? 0;
  const remaining = (action.remaining_recipients ?? action.recipients)
    .map((row) => {
      const address = row.address.toLowerCase();
      const available = allocations.get(address) ?? 0;
      const credit = Math.min(row.amount, available);
      allocations.set(address, available - credit);
      action.credited_tokens = (action.credited_tokens ?? 0) + credit;
      return { ...row, amount: row.amount - credit };
    })
    .filter((row) => row.amount > 0);
  action.remaining_recipients = remaining;
  if (remaining.length || (action.credited_tokens ?? 0) <= creditedBefore)
    return;
  if (action.recovery?.outcome) {
    action.recovery_history = [
      ...(action.recovery_history ?? []),
      action.recovery
    ];
    delete action.recovery;
    delete action.signed_tx;
  }
  action.state = 'CONFIRMED';
  action.hash = proof.hash;
  action.block_number = receipt.blockNumber;
  action.block_hash = receipt.blockHash;
  action.observed = true;
  reportActionSkip(record, action);
}

function creditPlannedAirdrops(
  record: LaunchRecord,
  decoded: TransactionDescription,
  proof: ManualProof,
  receipt: ChainReceipt
): void {
  const allocations = manualAllocations(
    decoded,
    'Invalid manual airdrop amount'
  );
  const available = availableAirdrops(record);
  if (!proof.action) assertUnambiguousAllocations(available, allocations);
  const selected = available.filter((it) =>
    matchesManualAction(it.label, it.phase, proof.action)
  );
  assertAvailableAllocations(selected, allocations);
  for (const action of selected)
    creditAction(record, action, allocations, proof, receipt);
  if (Array.from(allocations.values()).some((it) => it !== 0))
    throw new LaunchSafetyError(
      'Manual airdrop exceeds remaining planned allocations; review before resuming'
    );
}

function applyManualTransaction(
  record: LaunchRecord,
  decoded: TransactionDescription,
  proof: ManualProof,
  receipt: ChainReceipt,
  publishedMetadata: string
): void {
  if (decoded.name === 'airdrop') {
    if (proof.action === 'RESEARCH_AIRDROP')
      creditManualResearch(
        record.data,
        manualAllocations(decoded, 'Invalid manual research airdrop amount'),
        proof.hash
      );
    else if (
      record.data.actions.some(
        (it) => it.kind === 'AIRDROP' && it.state !== 'CONFIRMED'
      )
    )
      creditPlannedAirdrops(record, decoded, proof, receipt);
  }
  if (
    decoded.name === 'updateClaim' &&
    decoded.args[2].location !== record.data.metadata
  ) {
    if (decoded.args[2].location !== publishedMetadata)
      throw new LaunchSafetyError(
        'Manual metadata update does not match the published Craft version'
      );
    record.data.metadata = publishedMetadata;
  }
  recordManualProof(record, decoded, proof, receipt);
}

function recordManualProof(
  record: LaunchRecord,
  decoded: TransactionDescription,
  proof: ManualProof,
  receipt: ChainReceipt
): void {
  // Initialize/update are observed from current chain configuration before the
  // next intent; receipts alone cannot adopt a different phase or metadata.
  proof.method = decoded.name;
  if (decoded.name !== 'airdrop') {
    const params = decoded.args[2];
    proof.metadata = String(params.location);
    const phase = record.data.phases.findIndex(
      (it) =>
        it.start === Number(params.startDate) &&
        it.end === Number(params.endDate) &&
        it.root === params.merkleRoot
    );
    if (phase >= 0) proof.phase = phase;
  }
  proof.state = 'CONFIRMED';
  proof.block_number = receipt.blockNumber;
  proof.block_hash = receipt.blockHash;
  addLaunchEvent(
    record,
    `Claim #${record.data.claim_id}: Manual ${decoded.name} confirmed: ${proof.hash}`
  );
}

export async function reconcileManual(
  record: LaunchRecord,
  chain: LaunchChain,
  config: DropForgeConfig,
  publishedMetadata: string = record.data.metadata
): Promise<boolean> {
  if (record.data.manual_lease) return false;
  await assertRecoveryCanonical(record, chain, config);
  await assertLatestManualCanonical(record, chain, config);
  for (const proof of record.data.manual_transactions ?? []) {
    if (proof.state !== 'PENDING') continue;
    if (proof.action === 'PAY_ARTIST') {
      const action = record.data.actions.find((it) => it.kind === 'PAY_ARTIST');
      if (!action || action.state !== 'PENDING' || !chain.inspectPayment)
        throw new LaunchSafetyError(
          'Artist payment cannot be credited while its signed intent is unresolved'
        );
      const receipt = await chain.inspectPayment(
        record.data,
        action,
        proof.hash
      );
      if (!receipt || receipt.confirmations < config.confirmations)
        return false;
      if (receipt.status !== 1)
        throw new LaunchSafetyError('Manual artist payment reverted');
      action.state = 'CONFIRMED';
      action.hash = proof.hash;
      action.block_number = receipt.blockNumber;
      action.block_hash = receipt.blockHash;
      action.observed = true;
      proof.state = 'CONFIRMED';
      proof.method = 'PAY_ARTIST';
      proof.block_number = receipt.blockNumber;
      proof.block_hash = receipt.blockHash;
      reportActionSkip(record, action);
      continue;
    }
    if (!chain.inspectTransaction)
      throw new LaunchSafetyError(
        'Manual transaction verification is unavailable'
      );
    const evidence = await chain.inspectTransaction(
      record.data.contract,
      record.data.claim_id,
      proof.hash
    );
    const receipt = evidence.receipt;
    if (!receipt || receipt.confirmations < config.confirmations) return false;
    if (receipt.status !== 1) {
      proof.state = 'FAILED';
      proof.block_number = receipt.blockNumber;
      proof.block_hash = receipt.blockHash;
      throw new LaunchSafetyError(`Manual transaction reverted: ${proof.hash}`);
    }
    const decoded = claimAbi.parseTransaction({ data: evidence.calldata })!;
    applyManualTransaction(record, decoded, proof, receipt, publishedMetadata);
  }
  return true;
}
