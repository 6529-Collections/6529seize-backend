import { RecoveryEvidence } from '@/drop-forge/drop-forge.recovery-chain';
import { Transaction } from 'ethers';
import { DropForgeRecovery } from '@/drop-forge/drop-forge.recovery';
import { DropForgeRepository } from '@/drop-forge/drop-forge.repository';
import { LaunchChain, encodeLaunchAction } from '@/drop-forge/drop-forge.chain';
import {
  testConfig,
  testLaunchData,
  testWallet
} from '@/drop-forge/drop-forge.test-fixtures';
import { ApiDropForgeRecoveryRequestOperationEnum as Operation } from '@/api/generated/models/ApiDropForgeRecoveryRequest';
import { clearDropForgeTestTables } from '@/drop-forge/drop-forge.db-test-fixtures';
import { LaunchRecord } from '@/drop-forge/drop-forge.types';
import { mintingClaimActionsDb } from '@/api/minting-claims/minting-claim-actions.db';
import * as supported from '@/minting-claims/minting-claim-actions';
import { sqlExecutor } from '@/sql-executor';
import {
  MINTING_CLAIM_ACTIONS_TABLE,
  SIGNED_RECORD_LOG_ENTRIES_TABLE
} from '@/constants';
const repository = new DropForgeRepository();
const walletId = `${testConfig.chainId}:${testConfig.signer.toLowerCase()}`;
function setupChain() {
  return {
    now: jest.fn().mockResolvedValue(2000),
    broadcast: jest.fn(),
    recoveryEvidence: jest.fn(
      async (): Promise<RecoveryEvidence | null> => null
    )
  };
}
async function start(label?: string) {
  const data = testLaunchData();
  const action = data.actions[1];
  if (label) action.label = label;
  action.signed_tx = await testWallet.signTransaction({
    to: data.proxy,
    nonce: 7,
    chainId: data.chain_id,
    data: encodeLaunchAction(data, action),
    gasLimit: BigInt(50000),
    gasPrice: BigInt(1)
  });
  action.hash = Transaction.from(action.signed_tx).hash!;
  action.state = 'SIGNED';
  const record: LaunchRecord = {
    id: 'recovery-launch',
    revision: 0,
    state: 'BLOCKED',
    error: 'stuck',
    data,
    updated_at: 0
  };
  await repository.wallet(
    walletId,
    async (pending, ctx) => {
      pending.launch_id = record.id;
      pending.action_id = action.id;
      await repository.save(record, ctx);
    },
    {}
  );
  return {
    record,
    action,
    request: {
      revision: record.revision,
      request_id: 'request',
      expected_hash: action.hash,
      action_id: action.id,
      operation: Operation.Cancel
    }
  };
}
beforeEach(clearDropForgeTestTables);
afterEach(() => jest.restoreAllMocks());
it('serializes repeated operator requests under the signer lock and creates one recovery attempt', async () => {
  const f = await start();
  const chain = setupChain();
  const recovery = new DropForgeRecovery(
    testConfig,
    repository,
    chain as unknown as LaunchChain
  );
  await Promise.all([
    recovery.request(f.record.id, testWallet.address, f.request, {}),
    recovery.request(f.record.id, testWallet.address, f.request, {})
  ]);
  const stored = (await repository.find(f.record.id, {}))!;
  expect(stored.data.actions[1].recovery!.attempts).toHaveLength(2);
  expect(stored.data.actions[1].recovery_requests).toHaveLength(1);
});
it('rolls back action settlement and wallet release together on a persistence failure, then reconciles once after restart', async () => {
  const f = await start();
  const chain = setupChain();
  const recovery = new DropForgeRecovery(
    testConfig,
    repository,
    chain as unknown as LaunchChain
  );
  await recovery.request(f.record.id, testWallet.address, f.request, {});
  chain.recoveryEvidence.mockResolvedValue({
    receipt: {
      status: 1,
      blockNumber: 100,
      blockHash: 'block',
      confirmations: 12
    },
    finalized: true,
    total: 1
  });
  const save = repository.save.bind(repository);
  let fail = true;
  jest.spyOn(repository, 'save').mockImplementation(async (record, ctx) => {
    if (fail && record.data.actions[1].recovery?.outcome) {
      fail = false;
      throw new Error('commit failure');
    }
    await save(record, ctx);
  });
  await recovery.tick(f.record.id);
  expect((await repository.find(f.record.id, {}))!.data.actions[1].state).toBe(
    'SIGNED'
  );
  await repository.wallet(
    walletId,
    async (pending) => {
      expect(pending.launch_id).toBe(f.record.id);
    },
    {}
  );
  await recovery.tick(f.record.id);
  const settled = (await repository.find(f.record.id, {}))!;
  expect(settled.data.actions[1].state).toBe('CONFIRMED');
  await repository.wallet(
    walletId,
    async (pending) => {
      expect(pending.launch_id).toBeNull();
    },
    {}
  );
  const count = settled.data.events.length;
  await recovery.tick(f.record.id);
  expect((await repository.find(f.record.id, {}))!.data.events).toHaveLength(
    count
  );
});
it('retains a reservation when a winner is mined but not finalized', async () => {
  const f = await start();
  const chain = setupChain();
  const recovery = new DropForgeRecovery(
    testConfig,
    repository,
    chain as unknown as LaunchChain
  );
  await recovery.request(f.record.id, testWallet.address, f.request, {});
  chain.recoveryEvidence.mockResolvedValue({
    receipt: {
      status: 1,
      blockNumber: 100,
      blockHash: 'block',
      confirmations: 12
    },
    finalized: false,
    total: 1
  });
  await recovery.tick(f.record.id);
  await repository.wallet(
    walletId,
    async (pending) => {
      expect(pending.launch_id).toBe(f.record.id);
    },
    {}
  );
  expect((await repository.find(f.record.id, {}))!.data.actions[1].state).toBe(
    'SIGNED'
  );
});
it('with the mint log on, settles a recovery whose completion flag fails to write, and leaves the flag for a later pass', async () => {
  jest
    .spyOn(supported, 'isSupportedMintingClaimActionType')
    .mockReturnValue(true);
  const saved = process.env.FEATURE_MINT_LOG_SHADOW;
  process.env.FEATURE_MINT_LOG_SHADOW = 'true';
  try {
    // The stuck airdrop is the only one in its group, so settling it
    // completes the group, and recovery mirrors its flag.
    const f = await start('Airdrop - Artist');
    expect(f.action.kind).toBe('AIRDROP');
    const chain = setupChain();
    const recovery = new DropForgeRecovery(
      testConfig,
      repository,
      chain as unknown as LaunchChain
    );
    await recovery.request(f.record.id, testWallet.address, f.request, {});
    chain.recoveryEvidence.mockResolvedValue({
      receipt: {
        status: 1,
        blockNumber: 100,
        blockHash: 'block',
        confirmations: 12
      },
      finalized: true,
      total: 1
    });
    const upsert = jest
      .spyOn(mintingClaimActionsDb, 'upsertAction')
      .mockRejectedValueOnce(
        Object.assign(new Error('Lock wait timeout exceeded'), {
          code: 'ER_LOCK_WAIT_TIMEOUT'
        })
      );

    await recovery.tick(f.record.id);

    expect(upsert).toHaveBeenCalledTimes(1);
    const settled = (await repository.find(f.record.id, {}))!;
    expect(settled.data.actions[1].state).toBe('CONFIRMED');
    expect(settled.data.completion_flags ?? []).not.toContain('ARTIST_AIRDROP');
    expect(
      settled.data.events.filter((event) =>
        event.content.includes('completion flag ARTIST_AIRDROP was not written')
      )
    ).toHaveLength(1);
    await repository.wallet(
      walletId,
      async (pending) => {
        expect(pending.launch_id).toBeNull();
      },
      {}
    );
    expect(
      await sqlExecutor.execute(
        `select action from ${MINTING_CLAIM_ACTIONS_TABLE}`
      )
    ).toEqual([]);
  } finally {
    if (saved === undefined) delete process.env.FEATURE_MINT_LOG_SHADOW;
    else process.env.FEATURE_MINT_LOG_SHADOW = saved;
    await sqlExecutor.execute(`delete from ${MINTING_CLAIM_ACTIONS_TABLE}`);
    await sqlExecutor.execute(
      `delete from ${SIGNED_RECORD_LOG_ENTRIES_TABLE} where lane = 'mint'`
    );
  }
});
