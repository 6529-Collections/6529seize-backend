import { createHash } from 'node:crypto';
import { getAddress, ZeroHash } from 'ethers';
import { computeAllowlistMerkle } from '@/api/minting-claims/allowlist-merkle';
import { DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES } from '@/airdrop-phases';
import { DropForgeConfig } from '@/drop-forge/drop-forge.config';
import {
  DistributionRow,
  LaunchAction,
  LaunchData,
  LaunchPhase,
  LaunchSafetyError
} from '@/drop-forge/drop-forge.types';

const automaticPhases = new Set<string>(DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES);

export interface LaunchPlanInput {
  initialize_at: number;
  phases: Array<{
    name: string;
    start: number;
    end: number;
    price_wei: string;
    is_public: boolean;
  }>;
  include_artist_airdrops: boolean;
  include_team_airdrops: boolean;
}
export interface LaunchSource {
  metadata: string;
  edition: number;
  rows: DistributionRow[];
}
export const hashLaunchSource = (source: LaunchSource) =>
  createHash('sha256').update(JSON.stringify(source)).digest('hex');

export function buildLaunchPlan(
  config: DropForgeConfig,
  claim: number,
  input: LaunchPlanInput,
  source: LaunchSource,
  now: number
): LaunchData {
  if (!source.metadata || source.edition < 1 || !source.rows.length)
    throw new LaunchSafetyError(
      'Published metadata, edition and prepared distribution are required'
    );
  if (
    !Number.isSafeInteger(claim) ||
    claim < 1 ||
    !Number.isSafeInteger(source.edition) ||
    source.edition > 0xffffffff
  )
    throw new LaunchSafetyError('Invalid claim or edition');
  if (
    input.initialize_at < now + 300 ||
    input.phases.length < 1 ||
    input.phases.length > 20
  )
    throw new LaunchSafetyError(
      'Initialization must be at least five minutes ahead; one to twenty phases are required'
    );
  const names = new Set<string>();
  const phases: LaunchPhase[] = input.phases.map((phase, index) => {
    if (names.has(phase.name) || automaticPhases.has(phase.name))
      throw new LaunchSafetyError('Phase names must be unique minting phases');
    names.add(phase.name);
    const earliest =
      index === 0
        ? input.initialize_at + 1800
        : input.phases[index - 1].end + 900;
    if (
      !Number.isSafeInteger(phase.start) ||
      !Number.isSafeInteger(phase.end) ||
      phase.start < earliest ||
      phase.end <= phase.start ||
      phase.end > 0xffffffffffff
    )
      throw new LaunchSafetyError(
        'Phases need ordered windows, a 30 minute preparation lead, and 15 minute transition gaps'
      );
    if (
      !/^\d+$/.test(phase.price_wei) ||
      BigInt(phase.price_wei) >= BigInt('0x1' + '0'.repeat(64))
    )
      throw new LaunchSafetyError('Invalid mint price');
    const entries = source.rows
      .filter(
        (row) => row.phase === phase.name && Number(row.count_allowlist) > 0
      )
      .map((row) => ({
        address: getAddress(row.wallet),
        amount: Number(row.count_allowlist)
      }));
    if (phase.is_public && entries.length)
      throw new LaunchSafetyError('Public phase cannot contain an allowlist');
    const root = phase.is_public
      ? ZeroHash
      : computeAllowlistMerkle(entries).merkleRoot;
    if (!root)
      throw new LaunchSafetyError(
        'An allowlist phase cannot have an empty root'
      );
    return { ...phase, price_wei: BigInt(phase.price_wei).toString(), root };
  });
  const unmapped = source.rows.some(
    (row) => Number(row.count_allowlist) > 0 && !names.has(row.phase)
  );
  if (unmapped)
    throw new LaunchSafetyError(
      'Every prepared allowlist phase must be configured'
    );
  const categories = DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES.filter(
    (name) =>
      name === 'Airdrop' ||
      (name === 'Airdrop - Artist' && input.include_artist_airdrops) ||
      (name === 'Airdrop - Team' && input.include_team_airdrops)
  );
  const sorted = deriveAirdropRecipients(source.rows, categories);
  if (sorted.reduce((sum, row) => sum + row.amount, 0) > source.edition)
    throw new LaunchSafetyError('Airdrops exceed edition size');
  if (sorted.length > 20000)
    throw new LaunchSafetyError(
      'Airdrop plan exceeds the 20000 recipient safety limit'
    );
  const minimumLead = Math.max(
    1800,
    (Math.ceil(sorted.length / 100) + 1) * (config.confirmations * 15 + 120) +
      120
  );
  if (phases[0].start - input.initialize_at < minimumLead)
    throw new LaunchSafetyError(
      `Initialization needs at least ${minimumLead} seconds before the first window for this batch count and confirmation policy`
    );
  const actions: LaunchAction[] = [
    {
      id: 'initialize',
      kind: 'INITIALIZE',
      phase: 0,
      due: input.initialize_at,
      deadline: phases[0].start,
      recipients: [],
      state: 'PENDING'
    }
  ];
  for (let offset = 0; offset < sorted.length; offset += 100)
    actions.push({
      id: `airdrop-${offset / 100}`,
      kind: 'AIRDROP',
      phase: 0,
      due: input.initialize_at,
      deadline: phases[0].start,
      recipients: sorted.slice(offset, offset + 100),
      state: 'PENDING'
    });
  for (let phase = 1; phase < phases.length; phase++)
    actions.push({
      id: `phase-${phase}`,
      kind: 'UPDATE',
      phase,
      due: phases[phase - 1].end + 1,
      deadline: phases[phase].start,
      recipients: [],
      state: 'PENDING'
    });
  return {
    chain_id: config.chainId,
    contract: config.creator,
    claim_id: claim,
    signer: config.signer,
    proxy: config.proxy,
    receiver: config.receiver,
    metadata: source.metadata,
    edition_size: source.edition,
    distribution_hash: hashLaunchSource(source),
    phases,
    categories,
    actions,
    events: []
  };
}

function deriveAirdropRecipients(
  rows: DistributionRow[],
  categories: readonly string[]
): Array<{ address: string; amount: number }> {
  const recipients = new Map<string, number>();
  for (const row of rows) {
    const selected =
      !automaticPhases.has(row.phase) || categories.includes(row.phase);
    const amount = Number(row.count_airdrop);
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new LaunchSafetyError('Invalid distribution amount');
    if (selected && amount) {
      const address = getAddress(row.wallet);
      recipients.set(address, (recipients.get(address) ?? 0) + amount);
    }
  }
  return Array.from(recipients, ([address, amount]) => ({
    address,
    amount
  })).sort((a, b) => a.address.localeCompare(b.address));
}
