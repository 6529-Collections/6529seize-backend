import {
  DELEGATION_CONTRACT_DEPLOYMENT_BLOCK,
  MEMES_CONTRACT,
  NEVER_DATE,
  USE_CASE_CONSOLIDATION,
  USE_CASE_MINTING
} from '@/constants';
import { EventType } from '@/entities/IDelegation';
import { Not } from 'typeorm';

// Every side-effecting dependency of the delegations loop is mocked, so the
// test can check which ones the backfill path reaches.
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

import * as db from '../db';
import * as delegations from '../delegations';
import * as ens from '../ens';
import { consolidateActivity } from '../aggregatedActivityLoop/aggregated_activity';
import { identitiesService } from '../api-serverless/src/identities/identities.service';
import { consolidateNftOwners } from '../nftOwnersLoop/nft_owners';
import { consolidateOwnerBalances } from '../ownersBalancesLoop/owners_balances';
import { consolidateSubscriptions } from '../subscriptionsDaily/subscriptions';
import { updateTDH } from '../tdhLoop/tdh';
import { consolidateAndPersistTDH } from '../tdhLoop/tdh_consolidation';
import { handler } from './index';
import { doInDbContext } from '../secrets';
import {
  getAffectedWallets,
  getAffectedWalletsForAddresses
} from './reconsolidation';
import type { ConsolidatedTDH } from '../entities/ITDH';

const COLD = '0xc01d000000000000000000000000000000000c01';
const HOT = '0x1111111111111111111111111111111111111111';

function storedRow(overrides: Record<string, unknown>) {
  return {
    block: 20_000_000,
    from_address: COLD,
    to_address: HOT,
    collection: MEMES_CONTRACT,
    use_case: USE_CASE_MINTING,
    expiry: NEVER_DATE,
    all_tokens: true,
    token_id: 61,
    ...overrides
  };
}

const consolidationRow = storedRow({
  block: 20_000_001,
  use_case: USE_CASE_CONSOLIDATION
});

describe('delegations loop on-demand reconsolidation', () => {
  const env = process.env;
  const affected = new Set([COLD, HOT]);
  const originalSnapshot = [{ consolidation_key: COLD }] as ConsolidatedTDH[];
  const replacementSnapshot = [{ consolidation_key: HOT }] as ConsolidatedTDH[];
  const blockTimestamp = new Date('2026-10-13T00:00:00Z');
  const invoke = (event: unknown) =>
    (handler as unknown as (event: unknown) => Promise<unknown>)(event);

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, SENTRY_ENVIRONMENT: 'delegationsLoop_staging' };
    delete process.env.DELEGATIONS_EXPIRY_TOKEN_SCOPE_BACKFILL;
    jest.mocked(doInDbContext).mockImplementation(async (work) => work());
    jest
      .mocked(db.fetchAllConsolidatedTdh)
      .mockResolvedValueOnce(originalSnapshot)
      .mockResolvedValueOnce(replacementSnapshot);
    jest.mocked(getAffectedWalletsForAddresses).mockResolvedValue(affected);
    jest.mocked(getAffectedWallets).mockResolvedValue(affected);
    jest.mocked(updateTDH).mockResolvedValue({
      block: 26_000_000,
      blockTimestamp,
      tdh: []
    });
  });

  afterAll(() => {
    process.env = env;
  });

  it('runs the complete shared pipeline and primary update without indexing', async () => {
    const result = await invoke({ action: 'reconsolidate', wallets: [COLD] });
    expect(getAffectedWalletsForAddresses).toHaveBeenCalledWith(
      [COLD],
      originalSnapshot
    );
    expect(consolidateAndPersistTDH).toHaveBeenCalledWith(
      26_000_000,
      blockTimestamp,
      {
        mode: 'PARTIAL',
        wallets: [COLD, HOT],
        currentConsolidatedTdh: replacementSnapshot
      }
    );
    const pipeline = [
      updateTDH,
      consolidateAndPersistTDH,
      consolidateNftOwners,
      consolidateOwnerBalances,
      consolidateActivity,
      consolidateSubscriptions,
      identitiesService.updatePrimaryAddresses
    ];
    pipeline.forEach((fn) => expect(fn).toHaveBeenCalledTimes(1));
    const calls = pipeline.map(
      (fn) => jest.mocked(fn).mock.invocationCallOrder[0]
    );
    expect(calls).toEqual([...calls].sort((a, b) => a - b));
    [
      consolidateNftOwners,
      consolidateOwnerBalances,
      consolidateActivity,
      consolidateSubscriptions,
      identitiesService.updatePrimaryAddresses
    ].forEach((fn) => expect(fn).toHaveBeenCalledWith(affected));
    [
      delegations.findDelegationTransactions,
      delegations.scanDelegationLogs,
      db.fetchLatestNftDelegationBlock,
      db.persistConsolidations,
      db.persistDelegations,
      db.persistNftDelegationBlock,
      ens.discoverEnsConsolidations,
      ens.discoverEnsDelegations
    ].forEach((fn) => expect(fn).not.toHaveBeenCalled());
    expect(result).toEqual({
      action: 'reconsolidate',
      status: 'completed',
      requested_wallets: [COLD],
      affected_wallets: [COLD, HOT],
      block: 26_000_000
    });
  });

  it('keeps the chain-event path on the same reconsolidation pipeline', async () => {
    jest.mocked(delegations.findDelegationTransactions).mockResolvedValue({
      latestBlock: 26_000_001,
      latestBlockTimestamp: 1,
      consolidations: [
        {
          block: 26_000_001,
          type: EventType.REGISTER,
          wallet1: COLD,
          wallet2: HOT
        }
      ],
      registrations: [],
      revocation: []
    });
    await invoke({ source: 'aws.events' });
    expect(getAffectedWallets).toHaveBeenCalledWith(
      expect.any(Array),
      originalSnapshot
    );
    expect(getAffectedWalletsForAddresses).not.toHaveBeenCalled();
    [
      updateTDH,
      consolidateAndPersistTDH,
      consolidateNftOwners,
      consolidateOwnerBalances,
      consolidateActivity,
      consolidateSubscriptions
    ].forEach((fn) => expect(fn).toHaveBeenCalledTimes(1));
    expect(db.persistNftDelegationBlock).toHaveBeenCalledWith(26_000_001, 1);
  });

  it('stops the pipeline and rejects the invocation when a stage fails', async () => {
    jest
      .mocked(consolidateOwnerBalances)
      .mockRejectedValue(new Error('balance failure'));
    await expect(
      invoke({ action: 'reconsolidate', wallets: [COLD] })
    ).rejects.toThrow('balance failure');
    expect(consolidateActivity).not.toHaveBeenCalled();
    expect(consolidateSubscriptions).not.toHaveBeenCalled();
    expect(identitiesService.updatePrimaryAddresses).not.toHaveBeenCalled();
    expect(db.persistNftDelegationBlock).not.toHaveBeenCalled();
  });

  it.each([
    'delegationsLoop_staging',
    'delegationsLoop_prod',
    'staging',
    'prod'
  ])('runs maintenance with environment label %s', async (environment) => {
    process.env.SENTRY_ENVIRONMENT = environment;
    await expect(
      invoke({ action: 'reconsolidate', wallets: [COLD] })
    ).resolves.toMatchObject({ action: 'reconsolidate', status: 'completed' });
    expect(consolidateSubscriptions).toHaveBeenCalledWith(affected);
    expect(identitiesService.updatePrimaryAddresses).toHaveBeenCalledWith(
      affected
    );
  });

  it.each(['staging', 'prod'])(
    'runs maintenance after a scheduled invocation loads %s secrets in the same runtime',
    async (environment) => {
      process.env.SENTRY_ENVIRONMENT = `delegationsLoop_${environment}`;
      jest.mocked(doInDbContext).mockImplementation(async (work) => {
        process.env.SENTRY_ENVIRONMENT = environment;
        return work();
      });
      jest.mocked(delegations.findDelegationTransactions).mockResolvedValue({
        latestBlock: 26_000_001,
        latestBlockTimestamp: 1,
        consolidations: [],
        registrations: [],
        revocation: []
      });

      await invoke({ source: 'aws.events' });
      expect(process.env.SENTRY_ENVIRONMENT).toBe(environment);
      await expect(
        invoke({ action: 'reconsolidate', wallets: [COLD] })
      ).resolves.toMatchObject({
        action: 'reconsolidate',
        status: 'completed'
      });
      expect(doInDbContext).toHaveBeenCalledTimes(2);
      expect(getAffectedWalletsForAddresses).toHaveBeenCalledWith(
        [COLD],
        originalSnapshot
      );
      expect(consolidateSubscriptions).toHaveBeenCalledWith(affected);
      expect(identitiesService.updatePrimaryAddresses).toHaveBeenCalledWith(
        affected
      );
    }
  );

  it('rejects an action while the backfill mode is configured', async () => {
    process.env.DELEGATIONS_EXPIRY_TOKEN_SCOPE_BACKFILL = 'apply';
    await expect(
      invoke({ action: 'reconsolidate', wallets: [COLD] })
    ).rejects.toThrow('backfill flag');
    loopPaths().forEach((fn) => expect(fn).not.toHaveBeenCalled());
    expect(getAffectedWalletsForAddresses).not.toHaveBeenCalled();
  });

  it('rejects malformed maintenance input before indexing or opening the database', async () => {
    await expect(
      invoke({ action: 'reconsolidate', wallets: [] })
    ).rejects.toThrow();
    expect(doInDbContext).not.toHaveBeenCalled();
    loopPaths().forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });
});
const tokenSpecificRow = storedRow({});

function fakeDataSource() {
  const repo = {
    // Behaves like the table: honours the use case 999 exclusion.
    find: jest.fn(async (options: { where: { use_case: unknown } }) =>
      JSON.stringify(options.where.use_case) ===
      JSON.stringify(Not(USE_CASE_CONSOLIDATION))
        ? [tokenSpecificRow]
        : [tokenSpecificRow, consolidationRow]
    ),
    delete: jest.fn(async () => ({ raw: [], affected: 1 })),
    update: jest.fn(async () => ({ raw: [], affected: 1, generatedMaps: [] })),
    save: jest.fn(async (rows: unknown) => rows)
  };
  const transaction = jest.fn(
    async (work: (manager: unknown) => Promise<unknown>) =>
      work({ getRepository: () => repo })
  );
  return { dataSource: { transaction, getRepository: () => repo }, repo };
}

const loopPaths = () => [
  db.persistConsolidations,
  db.persistDelegations,
  db.persistNftDelegationBlock,
  db.fetchAllConsolidatedTdh,
  delegations.findDelegationTransactions,
  ens.discoverEnsDelegations,
  ens.discoverEnsConsolidations,
  updateTDH,
  consolidateAndPersistTDH,
  consolidateNftOwners,
  consolidateOwnerBalances,
  consolidateActivity,
  consolidateSubscriptions,
  identitiesService.updatePrimaryAddresses
];

describe('delegations loop handler with DELEGATIONS_EXPIRY_TOKEN_SCOPE_BACKFILL', () => {
  const env = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env };
    jest.mocked(db.fetchLatestNftDelegationBlock).mockResolvedValue(26_000_000);
    jest.mocked(delegations.scanDelegationLogs).mockResolvedValue({
      logs: [],
      consolidations: [],
      registrations: [
        {
          block: 20_000_000,
          type: EventType.REGISTER,
          wallet1: COLD,
          wallet2: HOT,
          collection: MEMES_CONTRACT,
          use_case: USE_CASE_MINTING,
          expiry: NEVER_DATE,
          all_tokens: false,
          token_id: 61
        }
      ],
      revocations: []
    });
  });

  afterAll(() => {
    process.env = env;
  });

  it('applies only the delegation diff, in one transaction', async () => {
    process.env.DELEGATIONS_EXPIRY_TOKEN_SCOPE_BACKFILL = 'apply';
    const { dataSource, repo } = fakeDataSource();
    jest.mocked(db.getDataSource).mockReturnValue(dataSource as never);

    await (handler as unknown as () => Promise<void>)();

    expect(delegations.scanDelegationLogs).toHaveBeenCalledWith(
      DELEGATION_CONTRACT_DEPLOYMENT_BLOCK,
      26_000_000
    );
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith(
      {
        block: 20_000_000,
        from_address: COLD,
        to_address: HOT,
        collection: MEMES_CONTRACT,
        use_case: USE_CASE_MINTING
      },
      { expiry: NEVER_DATE, all_tokens: false, token_id: 61 }
    );
    expect(repo.delete).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
    for (const fn of loopPaths()) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('writes nothing in dry-run', async () => {
    process.env.DELEGATIONS_EXPIRY_TOKEN_SCOPE_BACKFILL = 'dry-run';
    const { dataSource } = fakeDataSource();
    jest.mocked(db.getDataSource).mockReturnValue(dataSource as never);

    await (handler as unknown as () => Promise<void>)();

    expect(delegations.scanDelegationLogs).toHaveBeenCalledTimes(1);
    expect(dataSource.transaction).not.toHaveBeenCalled();
    for (const fn of loopPaths()) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('runs the normal loop when the flag is not set', async () => {
    delete process.env.DELEGATIONS_EXPIRY_TOKEN_SCOPE_BACKFILL;
    jest.mocked(delegations.findDelegationTransactions).mockResolvedValue({
      latestBlock: 26_000_001,
      latestBlockTimestamp: 1,
      consolidations: [],
      registrations: [],
      revocation: []
    });

    await (handler as unknown as () => Promise<void>)();

    expect(delegations.scanDelegationLogs).not.toHaveBeenCalled();
    expect(delegations.findDelegationTransactions).toHaveBeenCalledTimes(1);
    expect(db.persistNftDelegationBlock).toHaveBeenCalledWith(26_000_001, 1);
  });
});
