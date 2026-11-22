// The delegations loop runs the identity mirror after its NFTDelegation work
// and re-keys the consolidated tables for wallets the chain regrouped. Every
// side effect is mocked.
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
  getDataSource: jest.fn()
}));
jest.mock('../delegations', () => ({
  findDelegationTransactions: jest.fn(),
  scanDelegationLogs: jest.fn(),
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
    regroupsDone: jest.fn(async () => undefined)
  }
}));

import * as db from '../db';
import * as delegations from '../delegations';
import { consolidateSubscriptions } from '../subscriptionsDaily/subscriptions';
import { updateTDH } from '../tdhLoop/tdh';
import { identityChainMirror } from '../identity-chain-mirror/identity-chain-mirror.service';
import {
  getAffectedWallets,
  getAffectedWalletsForAddresses
} from './reconsolidation';
import { identitiesService } from '../api-serverless/src/identities/identities.service';
import { handler } from './index';

const A = '0x' + '01'.repeat(20);
const C = '0x' + '03'.repeat(20);
const invoke = (msLeft?: number) =>
  (
    handler as unknown as (
      event: unknown,
      context?: { getRemainingTimeInMillis: () => number }
    ) => Promise<unknown>
  )(
    {},
    msLeft === undefined
      ? undefined
      : { getRemainingTimeInMillis: () => msLeft }
  );

function report(regroupedWallets: string[]) {
  return {
    mode: 'feed',
    identities: 1,
    ratingTargets: 0,
    delegationWallets: 0,
    feedBlocks: 3,
    skippedTooManyWallets: [],
    skippedInactive: [],
    failed: [],
    docProblems: [],
    regroupedWallets,
    nextHeight: 10
  };
}

describe('delegations loop and the identity mirror', () => {
  const env = process.env;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env };
    delete process.env.DELEGATIONS_EXPIRY_TOKEN_SCOPE_BACKFILL;
    jest.mocked(db.fetchLatestNftDelegationBlock).mockResolvedValue(90);
    jest.mocked(delegations.findDelegationTransactions).mockResolvedValue({
      latestBlock: 100,
      latestBlockTimestamp: 1,
      consolidations: [],
      registrations: [],
      revocation: []
    });
    jest.mocked(db.fetchAllConsolidatedTdh).mockResolvedValue([]);
    jest.mocked(identityChainMirror.pendingRegroups).mockResolvedValue([]);
    jest
      .mocked(getAffectedWalletsForAddresses)
      .mockResolvedValue(new Set<string>());
    jest.mocked(updateTDH).mockResolvedValue({
      block: 100,
      blockTimestamp: new Date(0),
      tdh: []
    });
  });
  afterAll(() => {
    process.env = env;
  });

  it('does not run the mirror while its flag is off', async () => {
    delete process.env.FEATURE_IDENTITY_CHAIN_MIRROR;
    await invoke();
    expect(identityChainMirror.run).not.toHaveBeenCalled();
    expect(db.persistNftDelegationBlock).toHaveBeenCalledWith(100, 1);
  });

  it('runs the mirror after the delegations work', async () => {
    process.env.FEATURE_IDENTITY_CHAIN_MIRROR = 'true';
    jest.mocked(identityChainMirror.run).mockResolvedValue(report([]) as never);
    await invoke();
    expect(identityChainMirror.run).toHaveBeenCalledTimes(1);
    expect(
      jest.mocked(identityChainMirror.run).mock.invocationCallOrder[0]
    ).toBeGreaterThan(
      jest.mocked(db.persistNftDelegationBlock).mock.invocationCallOrder[0]
    );
    expect(updateTDH).not.toHaveBeenCalled();
  });

  it('re-keys what a stopped mirror run regrouped, then fails the run', async () => {
    process.env.FEATURE_IDENTITY_CHAIN_MIRROR = 'true';
    jest.mocked(identityChainMirror.run).mockResolvedValue({
      ...report([A]),
      error: 'lost connection'
    } as never);
    jest.mocked(identityChainMirror.pendingRegroups).mockResolvedValue([A]);
    jest
      .mocked(getAffectedWalletsForAddresses)
      .mockResolvedValue(new Set([A]) as never);
    await expect(invoke()).rejects.toThrow('lost connection');
    expect(getAffectedWalletsForAddresses).toHaveBeenCalledWith(
      [A],
      expect.anything()
    );
    expect(identityChainMirror.regroupsDone).toHaveBeenCalledWith(
      [A],
      expect.any(Number)
    );
    expect(identityChainMirror.followProfileSites).not.toHaveBeenCalled();
  });

  it('re-keys wallets an earlier run queued but did not re-key', async () => {
    process.env.FEATURE_IDENTITY_CHAIN_MIRROR = 'true';
    // This run regroups nothing; a run killed after its commits left C.
    jest.mocked(identityChainMirror.run).mockResolvedValue(report([]) as never);
    jest.mocked(identityChainMirror.pendingRegroups).mockResolvedValue([C]);
    jest
      .mocked(getAffectedWalletsForAddresses)
      .mockResolvedValue(new Set([C]) as never);
    await invoke();
    expect(getAffectedWalletsForAddresses).toHaveBeenCalledWith([C], []);
    expect(identityChainMirror.regroupsDone).toHaveBeenCalledWith(
      [C],
      expect.any(Number)
    );
  });

  it('keeps queued wallets when re-keying fails', async () => {
    process.env.FEATURE_IDENTITY_CHAIN_MIRROR = 'true';
    jest.mocked(identityChainMirror.run).mockResolvedValue(report([]) as never);
    jest.mocked(identityChainMirror.pendingRegroups).mockResolvedValue([C]);
    jest
      .mocked(getAffectedWalletsForAddresses)
      .mockRejectedValue(new Error('tdh read failed'));
    await expect(invoke()).rejects.toThrow('tdh read failed');
    expect(identityChainMirror.regroupsDone).not.toHaveBeenCalled();
  });

  it('sizes the mirror run by the time the Lambda has left', async () => {
    process.env.FEATURE_IDENTITY_CHAIN_MIRROR = 'true';
    jest.mocked(identityChainMirror.run).mockResolvedValue(report([]) as never);
    await invoke(7 * 60_000);
    // 7 minutes left: 4 kept for the re-keying and the end.
    expect(identityChainMirror.run).toHaveBeenCalledWith({
      budgetMs: 3 * 60_000
    });
    expect(identityChainMirror.followProfileSites).toHaveBeenCalledWith(
      undefined,
      expect.any(Number)
    );
    jest.clearAllMocks();
    await invoke(4 * 60_000 + 10_000);
    expect(identityChainMirror.run).not.toHaveBeenCalled();
    expect(identityChainMirror.pendingRegroups).toHaveBeenCalled();
  });

  it('applies no NFTDelegation event once identities are on the chain', async () => {
    process.env.FEATURE_IDENTITY_CHAIN_MIRROR = 'true';
    jest.mocked(identityChainMirror.run).mockResolvedValue(report([]) as never);
    jest.mocked(delegations.findDelegationTransactions).mockResolvedValue({
      latestBlock: 100,
      latestBlockTimestamp: 1,
      consolidations: [{ block: 99, wallet1: A, wallet2: C } as never],
      registrations: [{ use_case: 1, wallet1: A } as never],
      revocation: []
    });
    await invoke();
    expect(db.persistConsolidations).not.toHaveBeenCalled();
    expect(db.persistDelegations).not.toHaveBeenCalled();
    expect(getAffectedWallets).not.toHaveBeenCalled();
    expect(identitiesService.updatePrimaryAddresses).not.toHaveBeenCalled();
    // The checkpoint still moves on.
    expect(db.persistNftDelegationBlock).toHaveBeenCalledWith(100, 1);
  });

  it('runs the mirror when the NFTDelegation work fails, then fails the run', async () => {
    process.env.FEATURE_IDENTITY_CHAIN_MIRROR = 'true';
    jest.mocked(identityChainMirror.run).mockResolvedValue(report([]) as never);
    jest
      .mocked(db.persistNftDelegationBlock)
      .mockRejectedValueOnce(new Error('checkpoint write failed'));
    await expect(invoke()).rejects.toThrow('checkpoint write failed');
    expect(identityChainMirror.run).toHaveBeenCalledTimes(1);
    delete process.env.FEATURE_IDENTITY_CHAIN_MIRROR;
    jest.clearAllMocks();
    jest
      .mocked(db.persistNftDelegationBlock)
      .mockRejectedValueOnce(new Error('checkpoint write failed'));
    await expect(invoke()).rejects.toThrow('checkpoint write failed');
    expect(identityChainMirror.run).not.toHaveBeenCalled();
  });

  it('re-keys the consolidated tables for regrouped wallets', async () => {
    process.env.FEATURE_IDENTITY_CHAIN_MIRROR = 'true';
    jest
      .mocked(identityChainMirror.run)
      .mockResolvedValue(report([A, C]) as never);
    jest.mocked(identityChainMirror.pendingRegroups).mockResolvedValue([A, C]);
    jest
      .mocked(getAffectedWalletsForAddresses)
      .mockResolvedValue(new Set([A, C]));
    await invoke();
    expect(getAffectedWalletsForAddresses).toHaveBeenCalledWith([A, C], []);
    expect(updateTDH).toHaveBeenCalledTimes(1);
    expect(consolidateSubscriptions).toHaveBeenCalledWith(new Set([A, C]));
    // The profile site followers run last, after the re-keying.
    expect(
      jest.mocked(identityChainMirror.followProfileSites).mock
        .invocationCallOrder[0]
    ).toBeGreaterThan(
      jest.mocked(consolidateSubscriptions).mock.invocationCallOrder[0]
    );
  });
});
