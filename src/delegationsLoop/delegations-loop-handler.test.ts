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
jest.mock('./reconsolidation', () => ({ getAffectedWallets: jest.fn() }));

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
