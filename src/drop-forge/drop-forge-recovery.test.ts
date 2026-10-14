import { DropForgeWorker } from '@/drop-forge/drop-forge.worker';
import { Transaction } from 'ethers';
import {
  DropForgeRecovery,
  originalRecovery
} from '@/drop-forge/drop-forge.recovery';
import { DropForgeRepository } from '@/drop-forge/drop-forge.repository';
import { LaunchChain, encodeLaunchAction } from '@/drop-forge/drop-forge.chain';
import { LaunchRecord } from '@/drop-forge/drop-forge.types';
import { ApiDropForgeRecoveryRequest } from '@/api/generated/models/ApiDropForgeRecoveryRequest';
import {
  testConfig,
  testLaunchData,
  testSource,
  testWallet
} from '@/drop-forge/drop-forge.test-fixtures';
import { mapLaunch } from '@/drop-forge/drop-forge.service';
jest.mock('@/api/minting-claims/minting-claim-actions.db', () => ({
  mintingClaimActionsDb: {
    upsertAction: jest.fn().mockResolvedValue(undefined)
  }
}));
function setup() {
  const data = testLaunchData();
  const action = data.actions[1];
  const record: LaunchRecord = {
    id: 'launch',
    revision: 1,
    state: 'BLOCKED',
    error: 'stuck',
    data,
    updated_at: 0
  };
  const pending = {
    launch_id: 'launch' as string | null,
    action_id: action.id as string | null
  };
  const evidence = new Map<
    string,
    {
      receipt: {
        status: number;
        blockNumber: number;
        blockHash: string;
        confirmations: number;
      };
      finalized: boolean;
      total: number;
    }
  >();
  const chain = {
    now: jest.fn().mockResolvedValue(2000),
    verify: jest.fn().mockResolvedValue(undefined),
    broadcast: jest.fn().mockResolvedValue(undefined),
    prepareRecovery: jest.fn(
      async (_: unknown, __: unknown, operation: string) =>
        Transaction.from({
          to: operation === 'CANCEL' ? data.signer : data.proxy,
          data:
            operation === 'CANCEL' ? '0x' : encodeLaunchAction(data, action),
          nonce: 7,
          chainId: data.chain_id,
          value: BigInt(0),
          gasLimit: BigInt(50000),
          gasPrice: BigInt(2)
        }).unsignedSerialized
    ),
    recoveryEvidence: jest.fn(
      async (_: unknown, __: unknown, attempt: { hash: string }) =>
        evidence.get(attempt.hash) ?? null
    )
  };
  const repository = {
    wallet: async (
      _: string,
      fn: (row: typeof pending, ctx: object) => Promise<unknown>
    ) => fn(pending, {}),
    lockLaunch: async () => record,
    source: async () => testSource,
    save: jest.fn(async () => {
      record.revision++;
    }),
    change: async (_: string, fn: (r: LaunchRecord) => Promise<void>) =>
      fn(record)
  } as unknown as DropForgeRepository;
  const signer = {
    sign: jest.fn(async (unsigned: string) =>
      testWallet.signTransaction(Transaction.from(unsigned))
    )
  };
  const recovery = new DropForgeRecovery(
    testConfig,
    repository,
    chain as unknown as LaunchChain,
    signer
  );
  const start = async () => {
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
  };
  const request = (operation: string, id = 'request') =>
    recovery.request(
      'launch',
      testWallet.address,
      {
        revision: record.revision,
        request_id: id,
        action_id: action.id,
        expected_hash: action.hash!,
        operation
      } as ApiDropForgeRecoveryRequest,
      {}
    );
  const ack = () =>
    data.events.forEach((event) => {
      event.drop_id = 'posted';
    });
  const mined = (hash: string, status = 1, finalized = true) =>
    evidence.set(hash, {
      receipt: {
        status,
        blockNumber: 100,
        blockHash: 'canonical',
        confirmations: 12
      },
      finalized,
      total: status ? 1 : 0
    });
  return {
    data,
    action,
    record,
    pending,
    chain,
    repository,
    signer,
    recovery,
    start,
    request,
    ack,
    mined,
    evidence
  };
}
it('keeps the same action/nonce and persists signed speed-up bytes before broadcast; restarts rebroadcast only those bytes', async () => {
  const f = setup();
  await f.start();
  await f.request('SPEED_UP');
  f.ack();
  f.chain.broadcast.mockImplementation(async (raw: string) => {
    expect(
      f.action.recovery!.attempts.some((attempt) => attempt.signed_tx === raw)
    ).toBe(true);
    throw new Error('broadcast timeout after acceptance');
  });
  await f.recovery.tick('launch');
  const attempt = f.action.recovery!.attempts[1];
  expect(Transaction.from(attempt.signed_tx!).nonce).toBe(7);
  await f.recovery.tick('launch');
  expect(f.signer.sign).toHaveBeenCalledTimes(1);
  expect(
    f.data.events.some(
      (event) => event.error && event.content.includes('uncertain')
    )
  ).toBe(true);
  expect(f.chain.broadcast.mock.calls.map(([raw]) => raw)).toEqual([
    attempt.signed_tx,
    attempt.signed_tx
  ]);
});
it.each(['original', 'replacement'])(
  'credits only the canonical %s winner of a speed-up race',
  async (winner) => {
    const f = setup();
    await f.start();
    await f.request('SPEED_UP');
    f.ack();
    await f.recovery.tick('launch');
    const attempt = f.action.recovery!.attempts[winner === 'original' ? 0 : 1];
    f.mined(attempt.hash!);
    await f.recovery.tick('launch');
    expect(f.action.state).toBe('CONFIRMED');
    expect(f.record.state).toBe('RUNNING');
    expect(f.pending.launch_id).toBeNull();
    expect(f.action.recovery!.winner_hash).toBe(attempt.hash);
    const events = f.data.events.length;
    await f.recovery.tick('launch');
    expect(f.data.events).toHaveLength(events);
  }
);
it('records a late original winner even after cancellation was requested; refuses fresh-nonce retry', async () => {
  const f = setup();
  await f.start();
  await f.request('CANCEL');
  f.ack();
  await f.recovery.tick('launch');
  f.chain.now.mockResolvedValue(9000);
  f.mined(f.action.recovery!.attempts[0].hash!);
  await f.recovery.tick('launch');
  expect(f.action.state).toBe('CONFIRMED');
  await expect(f.request('RETRY', 'retry')).rejects.toThrow('outstanding work');
});
it('cancellation consumes the nonce but does not credit allocations; allows a reviewed retry only after finality', async () => {
  const f = setup();
  await f.start();
  await f.request('CANCEL');
  f.ack();
  await f.recovery.tick('launch');
  const cancel = f.action.recovery!.attempts[1];
  f.mined(cancel.hash!);
  await f.recovery.tick('launch');
  expect(f.action.state).toBe('CANCELLED');
  expect(f.action.credited_tokens).toBeUndefined();
  expect(f.action.recipients[0].amount).toBe(1);
  const retryBody = {
    revision: f.record.revision,
    request_id: 'retry',
    action_id: f.action.id,
    expected_hash: f.action.hash!,
    operation: 'RETRY'
  } as ApiDropForgeRecoveryRequest;
  await f.recovery.request('launch', testWallet.address, retryBody, {});
  expect(f.action.state).toBe('PENDING');
  expect(f.action.signed_tx).toBeUndefined();
  expect(f.action.recovery_history![0].outcome).toBe('CANCELLED');
  await f.recovery.request('launch', testWallet.address, retryBody, {});
  expect(f.action.recovery_history).toHaveLength(1);
});
it('does not release a mined but unfinalized winner and survives its reorg before another attempt wins', async () => {
  const f = setup();
  await f.start();
  await f.request('CANCEL');
  f.ack();
  await f.recovery.tick('launch');
  const [original, cancel] = f.action.recovery!.attempts;
  f.mined(original.hash!, 1, false);
  await f.recovery.tick('launch');
  expect(f.pending.launch_id).toBe('launch');
  expect(f.action.state).toBe('SIGNED');
  f.evidence.delete(original.hash!);
  f.mined(cancel.hash!);
  await f.recovery.tick('launch');
  expect(f.action.state).toBe('CANCELLED');
  expect(f.pending.launch_id).toBeNull();
});
it('blocks retry when previously finalized cancellation evidence disappears', async () => {
  const f = setup();
  await f.start();
  await f.request('CANCEL');
  f.ack();
  await f.recovery.tick('launch');
  f.mined(f.action.recovery!.attempts[1].hash!);
  await f.recovery.tick('launch');
  f.evidence.clear();
  await expect(f.request('RETRY', 'retry')).rejects.toThrow('canonical');
  expect(f.action.state).toBe('CANCELLED');
});
it('deduplicates request retries, rejects stale inspection and exposes no signed/unsigned bytes', async () => {
  const f = setup();
  await f.start();
  await f.request('CANCEL');
  await f.request('CANCEL');
  expect(f.action.recovery!.attempts).toHaveLength(2);
  await expect(
    f.recovery.request(
      'launch',
      testWallet.address,
      {
        revision: f.record.revision,
        request_id: 'request',
        action_id: f.action.id,
        expected_hash: 'different',
        operation: 'CANCEL'
      } as ApiDropForgeRecoveryRequest,
      {}
    )
  ).rejects.toThrow('different instruction');
  await expect(
    f.recovery.request(
      'launch',
      testWallet.address,
      {
        revision: 1,
        action_id: f.action.id,
        expected_hash: f.action.hash!,
        operation: 'CANCEL',
        request_id: 'other'
      } as ApiDropForgeRecoveryRequest,
      {}
    )
  ).rejects.toThrow('changed');
  const response = JSON.stringify(mapLaunch(f.record));
  expect(response).not.toContain('signed_tx');
  expect(response).not.toContain(f.action.signed_tx!);
});
it('never broadcasts the original after cancellation and resumes unsigned cancellation preparation after a crash', async () => {
  const f = setup();
  await f.start();
  await f.request('CANCEL');
  f.ack();
  f.signer.sign.mockRejectedValueOnce(new Error('KMS unavailable'));
  await f.recovery.tick('launch');
  expect(f.pending.launch_id).toBe('launch');
  expect(f.chain.broadcast).not.toHaveBeenCalled();
  f.ack();
  await f.recovery.tick('launch');
  const raw = f.chain.broadcast.mock.calls[0][0];
  expect(Transaction.from(raw).data).toBe('0x');
  expect(Transaction.from(raw).to).toBe(testWallet.address);
});
it('refuses speed-ups after the deadline and permits cancellation instead', async () => {
  const f = setup();
  await f.start();
  f.chain.now.mockResolvedValue(f.action.deadline);
  await expect(f.request('SPEED_UP')).rejects.toThrow('closed');
});
it('retains entitlement and explicitly schedules late delivery only after all minting closes', async () => {
  const f = setup();
  await f.start();
  await f.request('CANCEL');
  f.ack();
  await f.recovery.tick('launch');
  f.mined(f.action.recovery!.attempts[1].hash!);
  await f.recovery.tick('launch');
  f.chain.now.mockResolvedValue(9000);
  await f.request('DELIVER_REMAINING', 'late');
  expect(f.action.late_delivery).toBe(true);
  expect(f.action.recipients[0].amount).toBe(1);
  expect(f.action.state).toBe('PENDING');
});
it('constructs an original recovery ledger only from persisted signed evidence', () => {
  expect(() => originalRecovery(testLaunchData().actions[1])).toThrow(
    'persisted'
  );
});

it('imports only a verified same-nonce cancellation and never signs another replacement while its receipt is pending', async () => {
  const f = setup();
  await f.start();
  const raw = await testWallet.signTransaction({
    to: testWallet.address,
    nonce: 7,
    chainId: f.data.chain_id,
    data: '0x',
    value: BigInt(0),
    gasLimit: BigInt(21000),
    gasPrice: BigInt(5)
  });
  const hash = Transaction.from(raw).hash!;
  const inspector = jest.fn().mockResolvedValue(raw);
  const chain = { ...f.chain, inspectRecovery: inspector };
  const recovery = new DropForgeRecovery(
    testConfig,
    f.repository,
    chain as unknown as LaunchChain,
    f.signer
  );
  await recovery.request(
    'launch',
    testWallet.address,
    {
      revision: f.record.revision,
      request_id: 'existing',
      action_id: f.action.id,
      expected_hash: f.action.hash!,
      operation: 'RECORD_WINNER',
      transaction_hash: hash
    } as ApiDropForgeRecoveryRequest,
    {}
  );
  f.mined(hash);
  await recovery.tick('launch');
  expect(f.action.state).toBe('CANCELLED');
  expect(f.signer.sign).not.toHaveBeenCalled();
});
it('allows cancellation to supersede an unsigned speed-up after its window closes', async () => {
  const f = setup();
  await f.start();
  await f.request('SPEED_UP', 'speed');
  f.chain.now.mockResolvedValue(f.action.deadline);
  await f.request('CANCEL', 'cancel');
  expect(f.action.recovery!.attempts.map((it) => it.operation)).toEqual([
    'ORIGINAL',
    'CANCEL'
  ]);
  f.ack();
  await f.recovery.tick('launch');
  expect(Transaction.from(f.chain.broadcast.mock.calls[0][0]).data).toBe('0x');
});

it('recovery-only execution releases unsigned reservations without signing or starting any phase', async () => {
  const f = setup();
  f.action.state = 'RESERVED';
  await new DropForgeWorker(
    testConfig,
    f.repository,
    f.chain as unknown as LaunchChain,
    f.signer,
    false
  ).tick();
  expect(f.action.state).toBe('PENDING');
  expect(f.pending.launch_id).toBeNull();
  expect(f.signer.sign).not.toHaveBeenCalled();
  expect(f.chain.broadcast).not.toHaveBeenCalled();
});

it('preserves an explicit operator pause after finalized recovery instead of reopening scheduled execution', async () => {
  const f = setup();
  await f.start();
  f.record.state = 'PAUSED';
  await f.request('CANCEL');
  f.ack();
  await f.recovery.tick('launch');
  f.mined(f.action.recovery!.attempts[1].hash!);
  await f.recovery.tick('launch');
  expect(f.pending.launch_id).toBeNull();
  expect(f.record.state).toBe('PAUSED');
});
