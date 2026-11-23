import { USE_CASE_PRIMARY_ADDRESS, MEMES_CONTRACT } from '@/constants';
import { EventType } from '@/entities/IDelegation';

// Every side-effecting dependency of the delegations loop is mocked, so the
// test can check what the frozen loop applies and what it only records.
jest.mock('../sentry.context', () => ({
  wrapLambdaHandler: (fn: unknown) => fn
}));
jest.mock('../secrets', () => ({
  doInDbContext: jest.fn(async (work: () => Promise<void>) => work())
}));
jest.mock('../db', () => ({
  fetchAllConsolidatedTdh: jest.fn(),
  fetchLatestNftDelegationBlock: jest.fn(),
  persistConsolidations: jest.fn(),
  persistDelegations: jest.fn(),
  persistNftDelegationBlock: jest.fn(),
  persistNftDelegationLogsAfterFreeze: jest.fn(),
  getDataSource: jest.fn()
}));
jest.mock('../delegations', () => ({
  findDelegationTransactions: jest.fn(),
  scanDelegationLogs: jest.fn(),
  scanDelegationLogsForRecord: jest.fn(),
  fetchDelegationChainHead: jest.fn(),
  fetchBlockTimestamp: jest.fn(),
  fetchDelegationTransaction: jest.fn()
}));
jest.mock('../ens', () => ({
  discoverEnsConsolidations: jest.fn(),
  discoverEnsDelegations: jest.fn()
}));
jest.mock('../aggregatedActivityLoop/aggregated_activity', () => ({
  consolidateActivity: jest.fn()
}));
jest.mock('../api-serverless/src/identities/identities.service', () => ({
  identitiesService: { updatePrimaryAddresses: jest.fn() }
}));
jest.mock('../nftOwnersLoop/nft_owners', () => ({
  consolidateNftOwners: jest.fn()
}));
jest.mock('../ownersBalancesLoop/owners_balances', () => ({
  consolidateOwnerBalances: jest.fn()
}));
jest.mock('../subscriptionsDaily/subscriptions', () => ({
  consolidateSubscriptions: jest.fn()
}));
jest.mock('../tdhLoop/tdh', () => ({ updateTDH: jest.fn() }));
jest.mock('../tdhLoop/tdh_consolidation', () => ({
  consolidateAndPersistTDH: jest.fn()
}));
jest.mock('./reconsolidation', () => ({
  getAffectedWallets: jest.fn(),
  getAffectedWalletsForAddresses: jest.fn()
}));
jest.mock('./delegations-loop-health', () => ({
  DelegationsLoopHealth: {
    start: jest.fn(async () => ({
      committedStage: jest.fn(),
      completed: jest.fn(),
      failed: jest.fn()
    }))
  }
}));
jest.mock('../identity-tdh-sync', () => ({
  resumePendingIdentityTdhSync: jest.fn(),
  startIdentitySyncBudget: jest.fn()
}));
jest.mock('../identity-chain-mirror/identity-chain-mirror.service', () => ({
  identityChainMirror: {
    run: jest.fn(),
    followProfileSites: jest.fn(async () => []),
    pendingRegroups: jest.fn(async () => []),
    regroupsDone: jest.fn(async () => undefined),
    unfinishedRegroups: jest.fn(async () => 0),
    regroupsStarted: jest.fn(async () => undefined)
  }
}));

import * as db from '../db';
import * as delegations from '../delegations';
import * as ens from '../ens';
import { identitiesService } from '../api-serverless/src/identities/identities.service';
import { identityChainMirror } from '../identity-chain-mirror/identity-chain-mirror.service';
import { updateTDH } from '../tdhLoop/tdh';
import { getAffectedWallets } from './reconsolidation';
import { handler } from './index';

const COLD = '0xc01d000000000000000000000000000000000c01';
const HOT = '0x1111111111111111111111111111111111111111';
const T = Date.UTC(2026, 10, 24) / 1000;

const invoke = () => (handler as unknown as () => Promise<unknown>)();

function eventsAt(block: number) {
  return {
    latestBlock: block,
    latestBlockTimestamp: 1,
    consolidations: [
      { block, type: EventType.REGISTER, wallet1: COLD, wallet2: HOT }
    ],
    registrations: [
      {
        block,
        type: EventType.REGISTER,
        wallet1: COLD,
        wallet2: HOT,
        collection: MEMES_CONTRACT,
        use_case: USE_CASE_PRIMARY_ADDRESS
      }
    ],
    revocation: []
  };
}

const recorded = [
  {
    block: 120,
    log_index: 3,
    transaction_hash: '0xabc',
    event_name: 'RegisterDelegation',
    delegator: COLD,
    actor: null,
    delegate: HOT,
    collection: MEMES_CONTRACT,
    use_case: 999,
    all_tokens: true,
    token_id: '0'
  }
];

function appliedNothing() {
  for (const fn of [
    delegations.findDelegationTransactions,
    db.persistConsolidations,
    db.persistDelegations,
    getAffectedWallets,
    updateTDH,
    identitiesService.updatePrimaryAddresses
  ]) {
    expect(fn).not.toHaveBeenCalled();
  }
}

describe('delegations loop with NFTDelegation frozen', () => {
  const env = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env };
    delete process.env.DELEGATIONS_RESET_BLOCK;
    delete process.env.DELEGATIONS_EXPIRY_TOKEN_SCOPE_BACKFILL;
    delete process.env.NFTDELEGATION_FREEZE_BLOCK;
    delete process.env.IDENTITY_FREEZE_AT;
    delete process.env.FEATURE_IDENTITY_CHAIN_MIRROR;
    jest.mocked(db.fetchLatestNftDelegationBlock).mockResolvedValue(90);
    jest
      .mocked(delegations.fetchDelegationChainHead)
      .mockResolvedValue({ block: 130, timestamp: T + 120 });
    jest
      .mocked(delegations.findDelegationTransactions)
      .mockImplementation(async (_from, to) => eventsAt(to!));
    jest
      .mocked(delegations.scanDelegationLogsForRecord)
      .mockResolvedValue(recorded);
    jest.mocked(getAffectedWallets).mockResolvedValue(new Set());
    jest.mocked(db.fetchAllConsolidatedTdh).mockResolvedValue([]);
  });

  afterAll(() => {
    process.env = env;
  });

  it('runs the loop exactly as before without a freeze setting', async () => {
    jest
      .mocked(delegations.findDelegationTransactions)
      .mockResolvedValue(eventsAt(130));
    await invoke();
    expect(delegations.findDelegationTransactions).toHaveBeenCalledWith(
      90,
      undefined
    );
    expect(delegations.fetchDelegationChainHead).not.toHaveBeenCalled();
    expect(delegations.scanDelegationLogsForRecord).not.toHaveBeenCalled();
    expect(db.persistNftDelegationLogsAfterFreeze).not.toHaveBeenCalled();
    expect(db.persistNftDelegationBlock).toHaveBeenCalledWith(130, 1);
  });

  it('applies up to the freeze block and records the rest', async () => {
    process.env.NFTDELEGATION_FREEZE_BLOCK = '110';
    await invoke();
    expect(delegations.findDelegationTransactions).toHaveBeenCalledTimes(1);
    expect(delegations.findDelegationTransactions).toHaveBeenCalledWith(
      90,
      110
    );
    expect(db.persistConsolidations).toHaveBeenCalledWith(
      undefined,
      eventsAt(110).consolidations,
      undefined
    );
    expect(db.persistDelegations).toHaveBeenCalledWith(
      undefined,
      eventsAt(110).registrations,
      []
    );
    expect(getAffectedWallets).toHaveBeenCalledTimes(1);
    expect(identitiesService.updatePrimaryAddresses).toHaveBeenCalledWith(
      new Set([COLD])
    );
    expect(delegations.scanDelegationLogsForRecord).toHaveBeenCalledWith(
      111,
      130
    );
    expect(db.persistNftDelegationLogsAfterFreeze).toHaveBeenCalledWith(
      recorded,
      110
    );
    expect(db.persistNftDelegationBlock).toHaveBeenCalledWith(130, T + 120);
  });

  it('applies nothing once the checkpoint is past the freeze block', async () => {
    process.env.NFTDELEGATION_FREEZE_BLOCK = '80';
    await invoke();
    appliedNothing();
    expect(ens.discoverEnsDelegations).toHaveBeenCalledTimes(1);
    expect(delegations.scanDelegationLogsForRecord).toHaveBeenCalledWith(
      90,
      130
    );
    expect(db.persistNftDelegationLogsAfterFreeze).toHaveBeenCalledWith(
      recorded,
      80
    );
    expect(db.persistNftDelegationBlock).toHaveBeenCalledWith(130, T + 120);
  });

  it('with the identity mirror on, applies nothing before the freeze block either, and records the rest', async () => {
    process.env.FEATURE_IDENTITY_CHAIN_MIRROR = 'true';
    process.env.NFTDELEGATION_FREEZE_BLOCK = '110';
    jest.mocked(identityChainMirror.run).mockResolvedValue({
      mode: 'feed',
      regroupedWallets: []
    } as never);
    await invoke();
    // Read up to the freeze block, so the checkpoint moves on.
    expect(delegations.findDelegationTransactions).toHaveBeenCalledWith(
      90,
      110
    );
    for (const fn of [
      db.persistConsolidations,
      db.persistDelegations,
      getAffectedWallets,
      updateTDH,
      identitiesService.updatePrimaryAddresses
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(ens.discoverEnsDelegations).toHaveBeenCalledTimes(1);
    expect(delegations.scanDelegationLogsForRecord).toHaveBeenCalledWith(
      111,
      130
    );
    expect(db.persistNftDelegationLogsAfterFreeze).toHaveBeenCalledWith(
      recorded,
      110
    );
    expect(db.persistNftDelegationBlock).toHaveBeenCalledWith(130, T + 120);
    expect(identityChainMirror.run).toHaveBeenCalledTimes(1);
  });

  it('does not rewind on a reset block after the freeze block', async () => {
    process.env.NFTDELEGATION_FREEZE_BLOCK = '80';
    process.env.DELEGATIONS_RESET_BLOCK = '85';
    jest.mocked(delegations.fetchBlockTimestamp).mockResolvedValue(T - 60);
    await invoke();
    appliedNothing();
    expect(db.fetchLatestNftDelegationBlock).not.toHaveBeenCalled();
    expect(delegations.scanDelegationLogsForRecord).toHaveBeenCalledWith(
      85,
      130
    );
  });

  it('replays from a reset block before the freeze only up to it', async () => {
    process.env.NFTDELEGATION_FREEZE_BLOCK = '110';
    process.env.DELEGATIONS_RESET_BLOCK = '70';
    jest.mocked(delegations.fetchBlockTimestamp).mockResolvedValue(T - 600);
    await invoke();
    expect(delegations.findDelegationTransactions).toHaveBeenCalledWith(
      70,
      110
    );
    expect(db.persistConsolidations).toHaveBeenCalledWith(
      70,
      eventsAt(110).consolidations,
      T - 600
    );
    expect(db.persistDelegations).toHaveBeenCalledWith(
      70,
      eventsAt(110).registrations,
      []
    );
  });

  it('with only the freeze time, applies everything while the head is before it', async () => {
    process.env.IDENTITY_FREEZE_AT = '2026-11-24T00:00:00Z';
    jest
      .mocked(delegations.fetchDelegationChainHead)
      .mockResolvedValue({ block: 130, timestamp: T - 1 });
    await invoke();
    expect(delegations.findDelegationTransactions).toHaveBeenCalledWith(
      90,
      130
    );
    expect(delegations.scanDelegationLogsForRecord).not.toHaveBeenCalled();
    expect(delegations.fetchBlockTimestamp).not.toHaveBeenCalled();
  });

  it('with only the freeze time, finds the last block before it once the head passes it', async () => {
    process.env.IDENTITY_FREEZE_AT = '2026-11-24T00:00:00Z';
    // Block 120 is the first stamped at T.
    jest
      .mocked(delegations.fetchBlockTimestamp)
      .mockImplementation(async (block) => T + 12 * (block - 120));
    await invoke();
    expect(delegations.findDelegationTransactions).toHaveBeenCalledWith(
      90,
      119
    );
    expect(delegations.scanDelegationLogsForRecord).toHaveBeenCalledWith(
      120,
      130
    );
    expect(db.persistNftDelegationLogsAfterFreeze).toHaveBeenCalledWith(
      recorded,
      119
    );
  });

  it('stops before any work on a freeze setting it cannot read', async () => {
    process.env.NFTDELEGATION_FREEZE_BLOCK = 'soon';
    await expect(invoke()).rejects.toThrow('NFTDELEGATION_FREEZE_BLOCK');
    appliedNothing();
    expect(db.persistNftDelegationBlock).not.toHaveBeenCalled();
    expect(delegations.fetchDelegationChainHead).not.toHaveBeenCalled();
  });

  it('refuses the scope backfill while frozen', async () => {
    process.env.NFTDELEGATION_FREEZE_BLOCK = '110';
    process.env.DELEGATIONS_EXPIRY_TOKEN_SCOPE_BACKFILL = 'apply';
    await expect(invoke()).rejects.toThrow('scope backfill');
    expect(delegations.scanDelegationLogs).not.toHaveBeenCalled();
    appliedNothing();
  });
});
