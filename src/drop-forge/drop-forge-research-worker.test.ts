import { Transaction } from 'ethers';
import { MEMES_CONTRACT } from '@/constants';
import { DropForgeWorker } from '@/drop-forge/drop-forge.worker';
import { DropForgeRepository } from '@/drop-forge/drop-forge.repository';
import {
  claimAbi,
  encodeLaunchAction,
  LaunchChain
} from '@/drop-forge/drop-forge.chain';
import {
  LaunchRecord,
  LaunchSafetyError,
  SupplyEvidenceError
} from '@/drop-forge/drop-forge.types';
import { buildLaunchPlan } from '@/drop-forge/drop-forge.plan';
import {
  testConfig,
  testPlan,
  testSource,
  testWallet
} from '@/drop-forge/drop-forge.test-fixtures';
import {
  isResearchAirdrop,
  researchAirdropAmount,
  verifyResearchSupply
} from '@/drop-forge/drop-forge.research';
import { mintingClaimActionsDb } from '@/api/minting-claims/minting-claim-actions.db';

jest.mock('@/drop-forge/drop-forge.settings', () => ({
  ...jest.requireActual('@/drop-forge/drop-forge.settings'),
  readForgeSettings: jest.fn(async () => ({
    revision: 1,
    automation_enabled: true,
    pay_artist_enabled: true
  }))
}));

jest.mock('@/api/minting-claims/minting-claim-actions.db', () => ({
  mintingClaimActionsDb: {
    upsertAction: jest.fn().mockResolvedValue(undefined)
  }
}));

function setup(total = 287) {
  const config = { ...testConfig, creator: MEMES_CONTRACT };
  const source = { ...testSource, edition: 305 };
  const data = buildLaunchPlan(config, 1, testPlan, source, 0);
  const research = data.actions.find(isResearchAirdrop)!;
  data.actions
    .filter((action) => !isResearchAirdrop(action))
    .forEach((action) => {
      action.state = 'CONFIRMED';
    });
  const record: LaunchRecord = {
    id: 'launch',
    revision: 1,
    state: 'RUNNING',
    error: null,
    data,
    updated_at: 0
  };
  const pending = {
    launch_id: null as string | null,
    action_id: null as string | null
  };
  let now = research.due - 1;
  let receipt = false;
  const chain = {
    verifySettlement: jest.fn().mockResolvedValue(undefined),
    now: jest.fn(async () => now),
    nonce: jest.fn().mockResolvedValue(0),
    completed: jest.fn(async () =>
      researchAirdropAmount(total, data.edition_size) === 0 ? { total } : null
    ),
    prepare: jest.fn(async () => {
      verifyResearchSupply(data, research, total, now, true);
      return Transaction.from({
        to: data.proxy,
        chainId: data.chain_id,
        nonce: 0,
        data: encodeLaunchAction(data, research),
        value: BigInt(0),
        gasLimit: BigInt(50000),
        gasPrice: BigInt(1)
      }).unsignedSerialized;
    }),
    verify: jest.fn(async () =>
      verifyResearchSupply(data, research, total, now, false)
    ),
    receipt: jest.fn(async () =>
      receipt
        ? {
            status: 1,
            blockNumber: 100,
            blockHash: 'canonical',
            confirmations: 12
          }
        : null
    ),
    broadcast: jest.fn().mockResolvedValue(undefined)
  };
  const repository = {
    wallet: async (
      _: string,
      operation: (value: typeof pending, ctx: object) => Promise<unknown>
    ) => operation(pending, {}),
    active: async () => [record],
    lockLaunch: async () => record,
    save: jest.fn().mockResolvedValue(undefined),
    source: async () => source
  } as unknown as DropForgeRepository;
  const signer = {
    sign: jest.fn(async (unsigned: string) =>
      testWallet.signTransaction(Transaction.from(unsigned))
    )
  };
  const worker = new DropForgeWorker(
    config,
    repository,
    chain as LaunchChain,
    signer
  );
  const acknowledge = () =>
    data.events.forEach((event) => {
      event.drop_id = 'posted';
    });
  return {
    worker,
    data,
    research,
    record,
    pending,
    signer,
    chain,
    acknowledge,
    advance: (seconds: number) => {
      now += seconds;
    },
    restart: () =>
      new DropForgeWorker(config, repository, chain as LaunchChain, signer),
    start: () => {
      now = research.due;
    },
    confirm: () => {
      receipt = true;
      total = 305;
    }
  };
}
beforeEach(() => jest.clearAllMocks());
it('waits for Research instead of finishing at the Public update, then signs one eighteen-token intent and mirrors completion', async () => {
  const {
    worker,
    research,
    record,
    pending,
    signer,
    chain,
    acknowledge,
    start,
    confirm
  } = setup();
  await worker.tick();
  expect(record.state).toBe('RUNNING');
  expect(chain.prepare).not.toHaveBeenCalled();
  start();
  await worker.tick();
  expect(research.state).toBe('RESERVED');
  acknowledge();
  await worker.tick();
  expect(research.state).toBe('SIGNED');
  expect(signer.sign).toHaveBeenCalledTimes(1);
  const args = claimAbi.decodeFunctionData(
    'airdrop',
    Transaction.from(research.signed_tx!).data
  );
  expect(args[3]).toEqual([BigInt(18)]);
  await worker.tick();
  expect(signer.sign).toHaveBeenCalledTimes(1);
  confirm();
  await worker.tick();
  expect(research.state).toBe('CONFIRMED');
  expect(pending.launch_id).toBeNull();
  expect(mintingClaimActionsDb.upsertAction).toHaveBeenCalledWith(
    expect.objectContaining({ action: 'RESEARCH_AIRDROP', completed: true }),
    expect.anything()
  );
  acknowledge();
  await worker.tick();
  expect(record.state).toBe('COMPLETED');
  expect(signer.sign).toHaveBeenCalledTimes(1);
});

it('retains a mined Research intent across indexing lag and restart without signing or broadcasting another delivery', async () => {
  const f = setup();
  f.start();
  await f.worker.tick();
  f.acknowledge();
  await f.worker.tick();
  const hash = f.research.hash;
  f.confirm();
  f.advance(61);
  f.chain.verifySettlement.mockRejectedValueOnce(
    new SupplyEvidenceError(
      { status: 'WAITING', checked_at: 1, rpc_total: 305, db_total: 287 },
      'Indexing lag'
    )
  );
  f.acknowledge();
  await f.restart().tick();
  expect(f.research.state).toBe('SIGNED');
  expect(f.pending.launch_id).toBe(f.record.id);
  expect(f.research.hash).toBe(hash);
  f.advance(61);
  f.acknowledge();
  await f.restart().tick();
  expect(f.research.state).toBe('CONFIRMED');
  expect(f.pending.launch_id).toBeNull();
  expect(f.signer.sign).toHaveBeenCalledTimes(1);
  expect(f.chain.broadcast).toHaveBeenCalledTimes(1);
});

it('blocks unexpected confirmed delivery evidence and keeps its reservation for operator recovery', async () => {
  const f = setup();
  f.start();
  await f.worker.tick();
  f.acknowledge();
  await f.worker.tick();
  f.confirm();
  f.advance(61);
  f.chain.verifySettlement.mockRejectedValue(
    new LaunchSafetyError('Wrong research mint recipient')
  );
  f.acknowledge();
  await f.worker.tick();
  expect(f.record.state).toBe('BLOCKED');
  expect(f.research.state).toBe('SIGNED');
  expect(f.pending.launch_id).toBe(f.record.id);
  f.advance(1000);
  f.acknowledge();
  await f.worker.tick();
  expect(f.chain.verifySettlement).toHaveBeenCalledTimes(1);
  expect(f.signer.sign).toHaveBeenCalledTimes(1);
});
it('observes confirmed manual Research with its transaction link without signing or broadcasting', async () => {
  const {
    worker,
    data,
    record,
    research,
    signer,
    chain,
    acknowledge,
    start,
    confirm
  } = setup(305);
  data.manual_transactions = [
    {
      hash: 'manual-research',
      action: 'RESEARCH_AIRDROP',
      method: 'airdrop',
      state: 'CONFIRMED',
      block_number: 100,
      block_hash: 'canonical'
    }
  ];
  confirm();
  start();
  await worker.tick();
  expect(research.state).toBe('CONFIRMED');
  expect(research.observed).toBe(true);
  expect(research.hash).toBe('manual-research');
  expect(signer.sign).not.toHaveBeenCalled();
  expect(chain.broadcast).not.toHaveBeenCalled();
  acknowledge();
  await worker.tick();
  expect(record.state).toBe('COMPLETED');
});
