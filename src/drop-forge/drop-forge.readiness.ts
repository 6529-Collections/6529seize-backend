import { Result, ZeroAddress, ZeroHash } from 'ethers';
import {
  DISTRIBUTION_PHASE_AIRDROP,
  DISTRIBUTION_PHASE_AIRDROP_ARTIST,
  DISTRIBUTION_PHASE_AIRDROP_TEAM
} from '@/airdrop-phases';
import { fetchMintingClaimByClaimId } from '@/api/minting-claims/api.minting-claims.db';
import { mintingClaimActionsDb } from '@/api/minting-claims/minting-claim-actions.db';
import { sendIdentityPushNotifications } from '@/api/push-notifications/push-notifications.service';
import { DbPoolName } from '@/db-query.options';
import {
  inspectDropForgeTransaction,
  claimAbi,
  readDropForgeClaim,
  rpcWithDeadline
} from '@/drop-forge/drop-forge.chain';
import { getDropForgeReportingConfig } from '@/drop-forge/drop-forge.config';
import { evidenceForClaim } from '@/drop-forge/drop-forge.evidence';
import { postForgeReport } from '@/drop-forge/drop-forge.notifier';
import { getDropForgePolicy } from '@/drop-forge/drop-forge.policy';
import {
  readinessAllocations,
  readinessMerkleRoots,
  recordReadinessCheck
} from '@/drop-forge/drop-forge.readiness.repository';
import { launchCardLink } from '@/drop-forge/drop-forge.reports';
import {
  dropForgeRepository,
  launchId
} from '@/drop-forge/drop-forge.repository';
import { STANDARD_MINT_PRICE_WEI } from '@/drop-forge/drop-forge.schedule';
import { LaunchAction, LaunchData } from '@/drop-forge/drop-forge.types';
import { getEthereumRpcProvider } from '@/ethereum-rpc/ethereum-rpc-provider';
import { Logger } from '@/logging';
import {
  getMintNumberForMintDate,
  getMintSchedule,
  isMintEligibleUtcDay
} from '@/memes-calendar';

const logger = Logger.get('DROP_FORGE_READINESS');
const checkpoints = [
  { time: '17:30', offsetMinutes: -10 },
  { time: '18:28', offsetMinutes: -2 },
  { time: '18:58', offsetMinutes: -2 },
  { time: '19:22', offsetMinutes: 2 }
];
const groups = [
  { phase: DISTRIBUTION_PHASE_AIRDROP, label: 'General airdrops', flag: null },
  {
    phase: DISTRIBUTION_PHASE_AIRDROP_ARTIST,
    label: 'Artist airdrops',
    flag: 'ARTIST_AIRDROP'
  },
  {
    phase: DISTRIBUTION_PHASE_AIRDROP_TEAM,
    label: 'Team airdrops',
    flag: 'TEAM_AIRDROP'
  },
  {
    phase: 'Phase 0',
    label: 'Phase 0 subscription airdrops',
    flag: 'PHASE0_AIRDROP'
  },
  {
    phase: 'Phase 1',
    label: 'Phase 1 subscription airdrops',
    flag: 'PHASE1_AIRDROP'
  },
  {
    phase: 'Phase 2',
    label: 'Phase 2 subscription airdrops',
    flag: 'PHASE2_AIRDROP'
  },
  {
    phase: 'Public',
    label: 'Public subscription airdrops',
    flag: 'PUBLIC_PHASE_AIRDROP'
  }
];
const checkpointGroups = [groups.slice(0, 4), [groups[4]], groups.slice(5), []];
const phaseKey = (name: string) => name.toLowerCase().replace(/\s/g, '');
const isPublic = (name: string) =>
  ['public', 'publicphase'].includes(phaseKey(name));
type Checkpoint = NonNullable<ReturnType<typeof resolveReadinessCheckpoint>>;
type Policy = ReturnType<typeof getDropForgePolicy>;
type AllocationGroup = (typeof groups)[number];
type ExpectedAllocations = Map<string, number>;

export function resolveReadinessCheckpoint(id: string) {
  const match = /^readiness:([0-3]):(.+)$/.exec(id);
  const scheduledAt = new Date(match?.[2] ?? '');
  if (!match || !Number.isFinite(+scheduledAt))
    throw new Error('Invalid Drop Forge readiness delivery');
  if (!isMintEligibleUtcDay(scheduledAt)) return null;
  const phaseIndex = Number(match[1]);
  const checkpoint = checkpoints[phaseIndex];
  const schedule = getMintSchedule(getMintNumberForMintDate(scheduledAt));
  const phase = schedule.phases[phaseIndex];
  if (+phase.start + checkpoint.offsetMinutes * 60_000 !== +scheduledAt)
    return null;
  return {
    ...checkpoint,
    scheduledAt,
    claimId: schedule.mintNumber,
    phase,
    phaseIndex
  };
}

function checkConfiguration(
  checkpoint: Checkpoint,
  claim: Result,
  blockTime: number,
  expected: {
    root: string | undefined;
    price: string;
    edition: number | null;
    receiver: string;
  }
): string[] {
  const { phase, claimId } = checkpoint;
  const start = +phase.start / 1000;
  const end = +phase.end / 1000;
  const issues: string[] = [];
  if (Number(claim.startDate) !== start || Number(claim.endDate) !== end)
    issues.push(`${phase.name} has the wrong on-chain mint window.`);
  if (expected.root === undefined)
    issues.push(
      `${phase.name} allowlist root is missing from the prepared distribution.`
    );
  else if (
    String(claim.merkleRoot).toLowerCase() !== expected.root.toLowerCase()
  )
    issues.push(
      `${phase.name} has the wrong on-chain ${phase.isPublic ? 'public access settings' : 'allowlist root'}.`
    );
  if (String(claim.cost) !== expected.price)
    issues.push(`${phase.name} has the wrong mint price.`);
  if (
    String(claim.paymentReceiver).toLowerCase() !==
      expected.receiver.toLowerCase() ||
    claim.erc20 !== ZeroAddress ||
    claim.signingAddress !== ZeroAddress
  )
    issues.push(`${phase.name} has unexpected payment or signing settings.`);
  if (
    Number(claim.tokenId) !== claimId ||
    (expected.edition !== null && Number(claim.totalMax) !== expected.edition)
  )
    issues.push('The on-chain claim has the wrong token ID or edition size.');
  if (phase.isPublic && (blockTime < start || blockTime >= end))
    issues.push(
      'Public minting is outside its active window in the latest block.'
    );
  return issues;
}

async function checkOnChain(
  policy: Policy,
  checkpoint: Checkpoint,
  expected: Parameters<typeof checkConfiguration>[3]
): Promise<string[]> {
  try {
    const provider = getEthereumRpcProvider(policy.chainId);
    const block = await rpcWithDeadline(provider.getBlock('latest'));
    if (!block || Math.abs(Date.now() / 1000 - block.timestamp) > 120)
      return ['The latest Ethereum block is unavailable or stale.'];
    const claim = await readDropForgeClaim(
      provider,
      {
        contract: policy.creator,
        claim_id: checkpoint.claimId,
        proxy: policy.proxy
      },
      block.number
    );
    return claim
      ? checkConfiguration(checkpoint, claim, block.timestamp, expected)
      : ['The claim is missing on-chain.'];
  } catch {
    return ['Could not verify the claim on Ethereum.'];
  }
}

function plannedBatches(
  plan: LaunchData | undefined,
  group: AllocationGroup
): LaunchAction[] {
  return (
    plan?.actions.filter((action) => {
      if (action.kind !== 'AIRDROP' || !action.label) return false;
      const label = phaseKey(action.label).replace(/subscriptionairdrops$/, '');
      if (group.flag === 'PUBLIC_PHASE_AIRDROP')
        return (
          isPublic(label) ||
          (!plan.separate_public_airdrops && label === 'phase2')
        );
      return label === phaseKey(group.phase);
    }) ?? []
  );
}

function expectedAllocations(
  group: AllocationGroup,
  rows: Awaited<ReturnType<typeof readinessAllocations>>,
  batches: LaunchAction[]
): ExpectedAllocations {
  const [distribution, publicSubscriptions] = rows;
  const key = phaseKey(group.phase);
  const totals = new Map<string, number>();
  for (const row of distribution) {
    if (
      phaseKey(row.phase) !== key &&
      !(key === 'public' && isPublic(row.phase))
    )
      continue;
    totals.set(row.wallet, (totals.get(row.wallet) ?? 0) + Number(row.total));
  }
  if (key === 'public') {
    for (const row of publicSubscriptions)
      totals.set(
        row.wallet,
        Math.max(totals.get(row.wallet) ?? 0, Number(row.total))
      );
  }
  if (totals.size === 0) {
    for (const batch of batches) {
      // An old combined Phase 2 batch alone cannot establish any Public recipients.
      if (key === 'public' && !batch.label?.toLowerCase().includes('public'))
        continue;
      for (const { address, amount } of batch.recipients) {
        const wallet = address.toLowerCase();
        totals.set(wallet, (totals.get(wallet) ?? 0) + amount);
      }
    }
  }
  return totals;
}

async function inspectManualAirdrops(
  policy: Policy,
  claimId: number,
  hashes: string[],
  expected: ExpectedAllocations
): Promise<'complete' | 'pending' | 'incomplete'> {
  if (!hashes.length) return 'incomplete';
  const provider = getEthereumRpcProvider(policy.chainId);
  const evidence = await Promise.allSettled(
    hashes.map((hash) =>
      inspectDropForgeTransaction(
        policy,
        provider,
        policy.creator,
        claimId,
        hash
      )
    )
  );
  const credited = new Map<string, number>();
  let pending = false;
  for (const result of evidence) {
    if (result.status === 'rejected') continue;
    const { calldata, receipt } = result.value;
    const transaction = claimAbi.parseTransaction({ data: calldata });
    if (transaction?.name !== 'airdrop') continue;
    if (receipt && receipt.status !== 1) continue;
    if (!receipt || receipt.confirmations < policy.confirmations) {
      pending = true;
      continue;
    }
    const wallets = transaction.args[2] as string[];
    const amounts = transaction.args[3] as bigint[];
    wallets.forEach((wallet, index) => {
      const key = wallet.toLowerCase();
      credited.set(key, (credited.get(key) ?? 0) + Number(amounts[index]));
    });
  }
  if (
    credited.size === expected.size &&
    Array.from(expected).every(
      ([wallet, amount]) => credited.get(wallet) === amount
    )
  )
    return 'complete';
  return pending ? 'pending' : 'incomplete';
}

async function checkAirdrops(
  policy: Policy,
  checkpoint: Checkpoint,
  plan: LaunchData | undefined
): Promise<string[]> {
  const required = checkpointGroups[checkpoint.phaseIndex];
  if (!required.length) return [];
  const { creator } = policy;
  const claimId = checkpoint.claimId;
  const [allocations, actions] = await Promise.all([
    readinessAllocations(creator, claimId),
    mintingClaimActionsDb.findByContractAndClaimId(creator, claimId, {})
  ]);
  const outstanding = required.flatMap((group) => {
    const batches = plannedBatches(plan, group);
    const expected = expectedAllocations(group, allocations, batches);
    if (!expected.size) return [];
    if (
      batches.length &&
      batches.every((action) => action.state === 'CONFIRMED')
    )
      return [];
    if (
      actions.some((action) => action.action === group.flag && action.completed)
    )
      return [];
    return [{ group, batches, expected }];
  });
  if (!outstanding.length) return [];
  const manual = await evidenceForClaim(policy, claimId, {});
  const issues = await Promise.all(
    outstanding.map(async ({ group, batches, expected }) => {
      const hashes =
        group.flag === null
          ? []
          : manual
              .filter((proof) => proof.action === group.flag)
              .map((proof) => proof.hash);
      const result = await inspectManualAirdrops(
        policy,
        claimId,
        hashes,
        expected
      );
      if (result === 'complete') return null;
      if (
        result === 'pending' ||
        batches.some((action) => action.state === 'SIGNED')
      )
        return `${group.label} are awaiting transaction confirmation.`;
      return `${group.label} are incomplete or have no completion record.`;
    })
  );
  return issues.filter((issue) => issue !== null);
}

async function collectReadiness(
  policy: Policy,
  checkpoint: Checkpoint,
  hasCard: boolean,
  edition: number | null
): Promise<string[]> {
  const { claimId, phaseIndex, phase } = checkpoint;
  const now = Date.now();
  if (
    (!phase.isPublic && now >= +phase.start) ||
    now - +checkpoint.scheduledAt >= 5 * 60_000
  )
    return [
      'The scheduled readiness check arrived late. Verify this phase in Drop Forge.'
    ];
  const record = await dropForgeRepository.find(
    launchId(policy.chainId, policy.creator, claimId),
    {}
  );
  const plan = record?.state === 'DRAFT' ? undefined : record?.data;
  const plannedPhase = plan?.phases[phaseIndex];
  const matchingPlan =
    plannedPhase?.start === +phase.start / 1000 &&
    plannedPhase.end === +phase.end / 1000
      ? plannedPhase
      : undefined;
  const storedRoot =
    phase.isPublic || matchingPlan
      ? undefined
      : (await readinessMerkleRoots(policy.creator, claimId)).find(
          (row) => phaseKey(row.phase) === phaseKey(phase.name)
        )?.merkle_root;
  const [configuration, airdrops] = await Promise.all([
    checkOnChain(policy, checkpoint, {
      root: phase.isPublic ? ZeroHash : (matchingPlan?.root ?? storedRoot),
      price: matchingPlan?.price_wei ?? STANDARD_MINT_PRICE_WEI,
      edition,
      receiver: policy.receiver
    }),
    checkAirdrops(policy, checkpoint, plan)
  ]);
  return [
    ...(hasCard
      ? []
      : ['No Drop Forge card was found for this scheduled claim.']),
    ...configuration,
    ...airdrops
  ];
}

export async function runReadinessDelivery(id: string): Promise<void> {
  const checkpoint = resolveReadinessCheckpoint(id);
  if (!checkpoint) return;
  const policy = getDropForgePolicy();
  const { claimId, phase, time } = checkpoint;
  const card = await fetchMintingClaimByClaimId(policy.creator, claimId, {
    forcePool: DbPoolName.WRITE
  });
  const issues = await collectReadiness(
    policy,
    checkpoint,
    !!card,
    card?.edition_size ? Number(card.edition_size) : null
  );
  const label = card
    ? launchCardLink(policy.chainId, claimId)
    : `Claim #${claimId}`;
  const pushes = await recordReadinessCheck(`${policy.chainId}:${id}`, (ctx) =>
    issues.length
      ? postForgeReport(
          getDropForgeReportingConfig(),
          `**${label} · ${phase.name} readiness · ${time} Athens**\n\n${issues.map((issue) => `- ${issue}`).join('\n')}`,
          true,
          ctx
        )
      : Promise.resolve(null)
  );
  if (!pushes.length) return;
  try {
    await sendIdentityPushNotifications(pushes);
  } catch {
    logger.warn('Readiness report is durable; push delivery failed');
  }
}
