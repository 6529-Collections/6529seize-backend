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
  DROP_FORGE_PLAN_VERSION,
  LaunchSafetyError
} from '@/drop-forge/drop-forge.types';
import { RESEARCH_DELAY_SECONDS } from '@/drop-forge/drop-forge.research';

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

function validateLaunchInput(
  claim: number,
  input: LaunchPlanInput,
  source: LaunchSource,
  now: number,
  immediate: boolean
): void {
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
    !Number.isSafeInteger(input.initialize_at) ||
    input.initialize_at < now + (immediate ? 0 : 300) ||
    input.phases.length < 1 ||
    input.phases.length > 20
  )
    throw new LaunchSafetyError(
      'Initialization must be at least five minutes ahead; one to twenty phases are required'
    );
}

function buildPhase(
  input: LaunchPlanInput,
  source: LaunchSource,
  names: Set<string>,
  phase: LaunchPlanInput['phases'][number],
  index: number
): LaunchPhase {
  if (names.has(phase.name) || automaticPhases.has(phase.name))
    throw new LaunchSafetyError('Phase names must be unique minting phases');
  names.add(phase.name);
  if (phase.is_public && index !== input.phases.length - 1)
    throw new LaunchSafetyError('Only the final minting phase can be public');
  const earliest =
    index === 0 ? input.initialize_at + 1 : input.phases[index - 1].end;
  if (
    !Number.isSafeInteger(phase.start) ||
    !Number.isSafeInteger(phase.end) ||
    phase.start < earliest ||
    phase.end <= phase.start ||
    phase.end > 0xffffffffffff
  )
    throw new LaunchSafetyError(
      'Phases need ordered, non-overlapping windows after initialization'
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
    throw new LaunchSafetyError('An allowlist phase cannot have an empty root');
  return { ...phase, price_wei: BigInt(phase.price_wei).toString(), root };
}

function buildPhases(
  input: LaunchPlanInput,
  source: LaunchSource
): LaunchPhase[] {
  const names = new Set<string>();
  const phases = input.phases.map((phase, index) =>
    buildPhase(input, source, names, phase, index)
  );
  const unmapped = source.rows.some(
    (row) =>
      !automaticPhases.has(row.phase) &&
      (Number(row.count_allowlist) > 0 || Number(row.count_airdrop) > 0) &&
      !names.has(row.phase)
  );
  if (unmapped)
    throw new LaunchSafetyError(
      'Every prepared allowlist phase must be configured'
    );
  return phases;
}

function airdropActions(
  groups: Array<{ label: string; recipients: LaunchAction['recipients'] }>,
  phase: number,
  due: number,
  deadline: number
): LaunchAction[] {
  const actions: LaunchAction[] = [];
  for (const [groupIndex, group] of Array.from(groups.entries())) {
    for (let offset = 0; offset < group.recipients.length; offset += 100)
      actions.push({
        id: `phase-${phase}-group-${groupIndex}-airdrop-${offset / 100}`,
        label: group.label,
        kind: 'AIRDROP',
        phase,
        due,
        deadline,
        recipients: group.recipients.slice(offset, offset + 100),
        state: 'PENDING'
      });
  }
  return actions;
}

function buildPhaseActions(
  config: DropForgeConfig,
  input: LaunchPlanInput,
  phases: LaunchPhase[],
  recipients: LaunchAction['recipients'][],
  categoryRecipients: Array<{
    label: string;
    recipients: LaunchAction['recipients'];
  }>
): LaunchAction[] {
  const actions: LaunchAction[] = [];
  for (let phase = 0; phase < phases.length; phase++) {
    const due = phase === 0 ? input.initialize_at : phases[phase - 1].end + 1;
    const groups = [
      ...(phase === 0 ? categoryRecipients : []),
      {
        label: `${phases[phase].name} Subscription Airdrops`,
        recipients: recipients[phase]
      }
    ];
    const batches = groups.reduce(
      (n, group) => n + Math.ceil(group.recipients.length / 100),
      0
    );
    const minimumLead = launchPreparationSeconds(config, batches + 1);
    const gaplessPublic =
      input.phases[phase].is_public &&
      phase > 0 &&
      phases[phase].start === phases[phase - 1].end;
    // A gapless public cutover becomes eligible only after Phase 2 closes.
    // It can therefore open late while its update obtains confirmations.
    const deadline = gaplessPublic
      ? Math.min(phases[phase].end, due + minimumLead)
      : phases[phase].start;
    if (deadline - due < minimumLead)
      throw new LaunchSafetyError(
        `Phase ${phases[phase].name} needs at least ${minimumLead} seconds for its update/initialization and ${batches} airdrop batches`
      );
    actions.push(
      {
        id: phase === 0 ? 'initialize' : `phase-${phase}`,
        kind: phase === 0 ? 'INITIALIZE' : 'UPDATE',
        phase,
        due,
        deadline,
        recipients: [],
        state: 'PENDING'
      },
      ...airdropActions(groups, phase, due, deadline)
    );
  }
  return actions;
}

export function buildLaunchPlan(
  config: DropForgeConfig,
  claim: number,
  input: LaunchPlanInput,
  source: LaunchSource,
  now: number,
  immediate = false
): LaunchData {
  validateLaunchInput(claim, input, source, now, immediate);
  const phases = buildPhases(input, source);
  const categories = DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES.filter(
    (name) =>
      name === 'Airdrop' ||
      (name === 'Airdrop - Artist' && input.include_artist_airdrops) ||
      (name === 'Airdrop - Team' && input.include_team_airdrops)
  );
  // Public subscriptions belong to the preceding allowlist transition when
  // public minting starts immediately after that window (the existing UI flow).
  const recipients = phases.map((phase, index) => {
    const selectedNames = [phase.name];

    const next = input.phases[index + 1];
    if (next?.is_public && next.start === phase.end)
      selectedNames.push(next.name);
    const previous = phases[index - 1];
    if (input.phases[index].is_public && previous?.end === phase.start)
      return [];
    return deriveAirdropRecipients(source.rows, selectedNames);
  });
  const categoryRecipients = categories.map((category) => ({
    label: category,
    recipients: deriveAirdropRecipients(source.rows, [category])
  }));
  const allRecipients = [
    ...recipients.flat(),
    ...categoryRecipients.flatMap((it) => it.recipients)
  ];
  if (allRecipients.reduce((sum, row) => sum + row.amount, 0) > source.edition)
    throw new LaunchSafetyError('Airdrops exceed edition size');
  if (allRecipients.length > 20000)
    throw new LaunchSafetyError(
      'Airdrop plan exceeds the 20000 recipient safety limit'
    );
  const actions = buildPhaseActions(
    config,
    input,
    phases,
    recipients,
    categoryRecipients
  );
  const finalPhase = phases.length - 1;
  const researchDue = phases[finalPhase].end + RESEARCH_DELAY_SECONDS;
  actions.push({
    id: 'research-airdrop',
    label: 'Research airdrop',
    kind: 'AIRDROP',
    phase: finalPhase,
    due: researchDue,
    deadline: researchDue + 24 * 60 * 60,
    recipients: [],
    state: 'PENDING'
  });
  return {
    plan_version: DROP_FORGE_PLAN_VERSION,
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
    const selected = categories.includes(row.phase);
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

// Ethereum slots plus one scheduler interval per serial transaction and the
// existing two-minute no-new-submission cutoff. This is admission budgeting,
// not a guarantee that a network or reporting outage will fit the window.
export function launchPreparationSeconds(
  config: DropForgeConfig,
  transactions: number
): number {
  return transactions * (config.confirmations * 12 + 60) + 120;
}

export const hashLaunchDistribution = (source: LaunchSource) =>
  hashLaunchSource({ ...source, metadata: '' });
export const sourceMatchesLaunch = (source: LaunchSource, data: LaunchData) =>
  (data.managed ? hashLaunchDistribution(source) : hashLaunchSource(source)) ===
  data.distribution_hash;
