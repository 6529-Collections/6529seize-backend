import { claimAbi, LaunchChain } from '@/drop-forge/drop-forge.chain';
import { LaunchRecord, LaunchSafetyError } from '@/drop-forge/drop-forge.types';
import { addLaunchEvent } from '@/drop-forge/drop-forge.repository';
import { DropForgeConfig } from '@/drop-forge/drop-forge.config';

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
export async function reconcileManual(
  record: LaunchRecord,
  chain: LaunchChain,
  config: DropForgeConfig,
  publishedMetadata: string = record.data.metadata
): Promise<boolean> {
  if (record.data.manual_lease) return false;
  const latest = [...(record.data.manual_transactions ?? [])]
    .filter((it) => it.state === 'CONFIRMED' || it.state === 'FAILED')
    .sort((a, b) => (b.block_number ?? 0) - (a.block_number ?? 0))[0];
  if (latest) {
    const receipt = await chain.receipt(latest.hash);
    if (
      !receipt ||
      receipt.status !== (latest.state === 'FAILED' ? 0 : 1) ||
      receipt.blockHash !== latest.block_hash ||
      receipt.confirmations < config.confirmations
    )
      throw new LaunchSafetyError(
        'A confirmed manual transaction is no longer canonical'
      );
  }
  for (const proof of record.data.manual_transactions ?? []) {
    if (proof.state !== 'PENDING') continue;
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
    if (
      decoded.name === 'airdrop' &&
      record.data.actions.some(
        (it) => it.kind === 'AIRDROP' && it.state !== 'CONFIRMED'
      )
    ) {
      const addresses = decoded.args[2] as string[];
      const amounts = decoded.args[3] as bigint[];
      const allocations = new Map<string, number>();
      addresses.forEach((address, index) => {
        const amount = Number(amounts[index]);
        if (!Number.isSafeInteger(amount) || amount <= 0)
          throw new LaunchSafetyError('Invalid manual airdrop amount');
        allocations.set(
          address.toLowerCase(),
          (allocations.get(address.toLowerCase()) ?? 0) + amount
        );
      });
      if (
        !proof.action &&
        Array.from(allocations.keys()).some(
          (address) =>
            new Set(
              record.data.actions
                .filter(
                  (it) =>
                    it.kind === 'AIRDROP' &&
                    it.state === 'PENDING' &&
                    (it.remaining_recipients ?? it.recipients).some(
                      (row) => row.address.toLowerCase() === address
                    )
                )
                .map((it) => `${it.phase}:${it.label ?? ''}`)
            ).size > 1
        )
      ) {
        throw new LaunchSafetyError(
          'Manual airdrop category is ambiguous; declare its category before reconciliation'
        );
      }
      const available = new Map<string, number>();
      for (const action of record.data.actions.filter(
        (it) =>
          it.kind === 'AIRDROP' &&
          it.state === 'PENDING' &&
          matchesManualAction(it.label, it.phase, proof.action)
      ))
        for (const row of action.remaining_recipients ?? action.recipients)
          available.set(
            row.address.toLowerCase(),
            (available.get(row.address.toLowerCase()) ?? 0) + row.amount
          );
      if (
        Array.from(allocations).some(
          ([address, amount]) => amount > (available.get(address) ?? 0)
        )
      )
        throw new LaunchSafetyError(
          'Manual airdrop exceeds remaining planned allocations; review before resuming'
        );
      for (const action of record.data.actions.filter(
        (it) =>
          it.kind === 'AIRDROP' &&
          it.state === 'PENDING' &&
          matchesManualAction(it.label, it.phase, proof.action)
      )) {
        const remaining = (action.remaining_recipients ?? action.recipients)
          .map((row) => {
            const available = allocations.get(row.address.toLowerCase()) ?? 0;
            const credit = Math.min(row.amount, available);
            allocations.set(row.address.toLowerCase(), available - credit);
            action.credited_tokens = (action.credited_tokens ?? 0) + credit;
            return { ...row, amount: row.amount - credit };
          })
          .filter((row) => row.amount > 0);
        action.remaining_recipients = remaining;
        if (!remaining.length) {
          action.state = 'CONFIRMED';
          action.hash = proof.hash;
          action.block_number = receipt.blockNumber;
          action.block_hash = receipt.blockHash;
        }
      }
      if (Array.from(allocations.values()).some((it) => it !== 0))
        throw new LaunchSafetyError(
          'Manual airdrop exceeds remaining planned allocations; review before resuming'
        );
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
  return true;
}
