import { JsonRpcProvider, Transaction } from 'ethers';
import { DropForgeWorker } from '@/drop-forge/drop-forge.worker';
import {
  DropForgeRepository,
  launchId,
  setLaunchState
} from '@/drop-forge/drop-forge.repository';
import {
  claimAbi,
  EthereumLaunchChain,
  LaunchChain
} from '@/drop-forge/drop-forge.chain';
import { LaunchRpcUnavailableError } from '@/drop-forge/drop-forge.types';
import {
  testConfig,
  testLaunchData,
  testSource,
  testWallet
} from '@/drop-forge/drop-forge.test-fixtures';
import { clearDropForgeTestTables } from '@/drop-forge/drop-forge.db-test-fixtures';
import { DROP_FORGE_LAUNCHES_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';

describe('Drop Forge durable worker', () => {
  beforeEach(clearDropForgeTestTables);
  const id = launchId(testConfig.chainId, testConfig.creator, 1);
  let repository: DropForgeRepository;
  let chain: jest.Mocked<LaunchChain>;
  let signer: { sign: jest.Mock<Promise<string>, [string]> };
  let worker: DropForgeWorker;
  beforeEach(async () => {
    repository = new DropForgeRepository();
    jest.spyOn(repository, 'source').mockResolvedValue(testSource);
    chain = {
      now: jest.fn().mockResolvedValue(1100),
      nonce: jest.fn().mockResolvedValue(0),
      prepare: jest.fn().mockResolvedValue(
        Transaction.from({
          type: 2,
          chainId: testConfig.chainId,
          nonce: 0,
          to: testConfig.proxy,
          data: '0x1234',
          gasLimit: 50000,
          maxFeePerGas: 100,
          maxPriorityFeePerGas: 1
        }).unsignedSerialized
      ),
      receipt: jest.fn().mockResolvedValue(null),
      broadcast: jest
        .fn()
        .mockRejectedValue(new Error('timeout after acceptance')),
      verify: jest.fn().mockResolvedValue(undefined)
    };
    signer = {
      sign: jest.fn((unsigned) =>
        testWallet.signTransaction(Transaction.from(unsigned))
      )
    };
    worker = new DropForgeWorker(testConfig, repository, chain, signer);
    await repository.putDraft(id, 0, testLaunchData(), {});
    await repository.change(
      id,
      async (record) => {
        record.state = 'ARMED';
      },
      {}
    );
  });
  afterEach(() => jest.restoreAllMocks());
  const read = () => repository.find(id, {});
  const acknowledgeReports = () =>
    repository.change(
      id,
      async (record) => {
        for (const event of record.data.events)
          event.drop_id = 'reported-' + event.id;
      },
      {}
    );
  const start = async () => {
    await worker.tick();
    await acknowledgeReports();
    await worker.tick();
  };
  it('targets one queued claim and respects another claim owning the shared signer', async () => {
    const second = testLaunchData();
    second.claim_id = 2;
    const other = launchId(testConfig.chainId, testConfig.creator, 2);
    await repository.putDraft(other, 0, second, {});
    await repository.change(
      other,
      (record) => {
        record.state = 'ARMED';
      },
      {}
    );
    jest
      .spyOn(repository, 'active')
      .mockRejectedValue(
        new Error('Global scan is not allowed for targeted delivery')
      );
    await worker.tick(other);
    expect((await repository.find(other, {}))!.data.actions[0].state).toBe(
      'RESERVED'
    );
    await worker.tick(id);
    expect((await read())!.data.actions[0].state).toBe('PENDING');
    expect(signer.sign).not.toHaveBeenCalled();
    expect(chain.broadcast).not.toHaveBeenCalled();
  });
  it('keeps fully missed launches out of the candidate limit while retaining manual reconciliation', async () => {
    const missed = Array.from({ length: 25 }, (_, index) => {
      const data = testLaunchData();
      data.claim_id = 100 + index;
      data.actions.forEach((action) => {
        action.window_reported = true;
      });
      return {
        id: launchId(testConfig.chainId, testConfig.creator, data.claim_id),
        revision: 1,
        state: 'RUNNING',
        error: null,
        data: JSON.stringify(data),
        updated_at: 0,
        report_pending: false
      };
    });
    await sqlExecutor.bulkInsert(
      DROP_FORGE_LAUNCHES_TABLE,
      missed,
      Object.keys(missed[0])
    );
    expect(
      (await repository.active(1100, {})).map((record) => record.id)
    ).toEqual([id]);
    await repository.change(
      missed[0].id,
      async (record) => {
        record.data.manual_transactions = [
          { hash: 'manual-proof', state: 'PENDING' }
        ];
      },
      {}
    );
    expect(
      (await repository.active(1100, {})).map((record) => record.id)
    ).toContain(missed[0].id);
  });
  it('blocks legacy flattened plans without signing or broadcasting', async () => {
    await repository.change(
      id,
      async (record) => {
        delete record.data.plan_version;
      },
      {}
    );
    await worker.tick();
    expect((await read())!.state).toBe('BLOCKED');
    expect(signer.sign).not.toHaveBeenCalled();
    expect(chain.broadcast).not.toHaveBeenCalled();
  });
  it('reconciles a legacy signed receipt but never rebroadcasts that intent', async () => {
    await start();
    await repository.change(
      id,
      async (record) => {
        delete record.data.plan_version;
      },
      {}
    );
    chain.broadcast.mockClear();
    await worker.tick();
    expect((await read())!.state).toBe('BLOCKED');
    expect(chain.broadcast).not.toHaveBeenCalled();
    chain.receipt.mockResolvedValue({
      status: 1,
      blockNumber: 100,
      blockHash: 'block',
      confirmations: 12
    });
    await worker.tick();
    expect((await read())!.data.actions[0].state).toBe('CONFIRMED');
    expect((await read())!.state).toBe('BLOCKED');
    expect(chain.broadcast).not.toHaveBeenCalled();
  });
  it('leaves the next phase pending until the preceding mint window closes', async () => {
    await repository.change(
      id,
      async (record) => {
        for (const action of record.data.actions.slice(0, 2)) {
          action.state = 'CONFIRMED';
          action.hash = 'confirmed';
          action.block_hash = 'block';
        }
      },
      {}
    );
    chain.receipt.mockResolvedValue({
      status: 1,
      blockNumber: 100,
      blockHash: 'block',
      confirmations: 12
    });
    chain.now.mockResolvedValue(5000);
    await worker.tick();
    expect(chain.prepare).not.toHaveBeenCalled();
    chain.now.mockResolvedValue(5001);
    await worker.tick();
    expect(chain.prepare.mock.calls[0][1].kind).toBe('UPDATE');
    expect(chain.prepare.mock.calls[0][1].phase).toBe(1);
  });
  it('records late initialization without repeating it or closing future groups', async () => {
    await start();
    chain.now.mockResolvedValue(4000);
    chain.receipt.mockResolvedValue({
      status: 1,
      blockNumber: 100,
      blockHash: 'block',
      confirmations: 12
    });
    await worker.tick();
    const saved = (await read())!;
    expect(saved.data.actions[0].state).toBe('CONFIRMED');
    expect(saved.state).toBe('RUNNING');
    expect(
      saved.data.events.some((event) =>
        event.content.includes('after its deadline')
      )
    ).toBe(true);
    await acknowledgeReports();
    await worker.tick();
    expect(chain.prepare).toHaveBeenCalledTimes(1);
  });
  it('does not commit signed intent when KMS returns after the submission cutoff', async () => {
    signer.sign.mockImplementation(async (unsigned) => {
      chain.now.mockResolvedValue(3880);
      return testWallet.signTransaction(Transaction.from(unsigned));
    });
    await start();
    const saved = (await read())!;
    expect(saved.state).toBe('RUNNING');
    expect(saved.data.actions[0].state).toBe('PENDING');
    expect(saved.data.actions[0].signed_tx).toBeUndefined();
    expect(chain.broadcast).not.toHaveBeenCalled();
  });
  it('persists before broadcast and retries the identical hash after an ambiguous timeout', async () => {
    await start();
    const saved = (await read())!;
    expect(saved.data.actions[0].state).toBe('SIGNED');
    expect(saved.data.actions[0].signed_tx).toBe(
      chain.broadcast.mock.calls[0][0]
    );
    chain.now.mockResolvedValue(1160);
    await new DropForgeWorker(testConfig, repository, chain, signer).tick();
    expect(chain.broadcast.mock.calls[1][0]).toBe(
      chain.broadcast.mock.calls[0][0]
    );
    expect(signer.sign).toHaveBeenCalledTimes(1);
    expect(chain.prepare).toHaveBeenCalledTimes(1);
  });
  it('serializes overlapping invocations to one nonce and one persisted broadcast transaction', async () => {
    await Promise.all([worker.tick(), worker.tick()]);
    await acknowledgeReports();
    await Promise.all([worker.tick(), worker.tick()]);
    expect(chain.prepare).toHaveBeenCalledTimes(1);
    expect(
      new Set(chain.broadcast.mock.calls.map((call) => call[0])).size
    ).toBe(1);
    expect(
      (await read())!.data.actions.filter((action) => action.state === 'SIGNED')
    ).toHaveLength(1);
  });
  it('rolls back an unsigned reservation when persistence fails instead of moving to another action', async () => {
    const save = repository.save.bind(repository);
    jest.spyOn(repository, 'save').mockImplementation(async (record, ctx) => {
      if (record.data.actions.some((action) => action.state === 'RESERVED'))
        throw new Error('reservation persistence failed');
      return save(record, ctx);
    });
    await expect(worker.tick()).rejects.toThrow(
      'reservation persistence failed'
    );
    expect((await read())!.data.actions[0].state).toBe('PENDING');
    expect(signer.sign).not.toHaveBeenCalled();
    expect(chain.prepare).toHaveBeenCalledTimes(1);
  });
  it('never broadcasts when committing the signed transaction fails', async () => {
    const original = repository.save.bind(repository);
    const save = jest
      .spyOn(repository, 'save')
      .mockImplementation(async (record, ctx) => {
        if (record.data.actions[0].state === 'SIGNED')
          throw new Error('DB commit failed');
        return original(record, ctx);
      });
    await expect(start()).rejects.toThrow('DB commit failed');
    expect(chain.broadcast).not.toHaveBeenCalled();
    expect((await read())!.data.actions[0].state).toBe('RESERVED');
    save.mockRestore();
    await worker.tick();
    expect(chain.broadcast).toHaveBeenCalledTimes(1);
  });
  it('blocks changed source data before signing', async () => {
    jest
      .spyOn(repository, 'source')
      .mockResolvedValue({ ...testSource, metadata: 'changed' });
    await worker.tick();
    expect((await read())!.data.actions[0].attempt_error).toContain('changed');
    expect(signer.sign).not.toHaveBeenCalled();
  });
  it('reconciles confirmations while paused and submits no further action', async () => {
    await start();
    await repository.change(
      id,
      async (record) => {
        record.state = 'PAUSED';
      },
      {}
    );
    await worker.tick();
    expect(chain.broadcast).toHaveBeenCalledTimes(1);
    chain.receipt.mockResolvedValue({
      status: 1,
      blockNumber: 100,
      blockHash: 'block',
      confirmations: 12
    });
    await worker.tick();
    expect((await read())!.state).toBe('PAUSED');
    expect((await read())!.data.actions[0].state).toBe('CONFIRMED');
    expect(signer.sign).toHaveBeenCalledTimes(1);
  });
  it('does not replay a reverted transaction', async () => {
    await start();
    chain.receipt.mockResolvedValue({
      status: 0,
      blockNumber: 100,
      blockHash: 'block',
      confirmations: 12
    });
    await worker.tick();
    await worker.tick();
    expect((await read())!.state).toBe('RUNNING');
    expect((await read())!.data.actions[0].state).toBe('FAILED');
    expect(signer.sign).toHaveBeenCalledTimes(1);
  });
  it('holds the signer on unknown nonce consumption instead of choosing another nonce', async () => {
    await start();
    chain.nonce.mockResolvedValue(1);
    await worker.tick();
    expect((await read())!.error).toContain('nonce was consumed');
    expect(chain.broadcast).toHaveBeenCalledTimes(1);
  });
  it('releases an expired unsigned reservation even when reporting is unavailable', async () => {
    await worker.tick();
    chain.now.mockResolvedValue(3880);
    await worker.tick();
    const saved = (await read())!;
    expect(saved.state).toBe('RUNNING');
    expect(saved.data.actions[0].state).toBe('PENDING');
    expect(saved.data.actions[0].unsigned_tx).toBeUndefined();
    expect(saved.data.actions[0].attempt_error).toContain(
      'Unsigned reservation expired'
    );
    expect(signer.sign).not.toHaveBeenCalled();
    expect(chain.broadcast).not.toHaveBeenCalled();
    await repository.wallet(
      `${testConfig.chainId}:${testConfig.signer.toLowerCase()}`,
      async (pending) => {
        expect(pending.launch_id).toBeNull();
        expect(pending.action_id).toBeNull();
      },
      {}
    );
  });
  it('keeps a reserved intent unsigned while its report is unavailable', async () => {
    await worker.tick();
    await worker.tick();
    expect((await read())!.data.actions[0].state).toBe('RESERVED');
    expect(signer.sign).not.toHaveBeenCalled();
    await acknowledgeReports();
    await worker.tick();
    expect(signer.sign).toHaveBeenCalledTimes(1);
  });
  it('rechecks new pause/resume reports when signing finishes', async () => {
    await worker.tick();
    await acknowledgeReports();
    signer.sign.mockImplementationOnce(async (unsigned) => {
      await repository.change(
        id,
        async (record) => {
          setLaunchState(record, 'PAUSED', 'Paused during signing');
          setLaunchState(record, 'RUNNING', 'Resumed during signing');
        },
        {}
      );
      return testWallet.signTransaction(Transaction.from(unsigned));
    });
    await worker.tick();
    const saved = (await read())!;
    expect(saved.data.actions[0].state).toBe('RESERVED');
    expect(saved.data.actions[0].signed_tx).toBeUndefined();
    expect(chain.broadcast).not.toHaveBeenCalled();
    await acknowledgeReports();
    await worker.tick();
    expect((await read())!.data.actions[0].state).toBe('SIGNED');
    expect(chain.broadcast).toHaveBeenCalledTimes(1);
  });
  it('finds a due launch behind twenty older future launches', async () => {
    await repository.change(
      id,
      async (record) => {
        for (const action of record.data.actions) action.due += 10000;
      },
      {}
    );
    const launches = Array.from({ length: 20 }, (_, index) => {
      const claim = index + 2;
      const data = testLaunchData();
      data.claim_id = claim;
      if (claim < 21) for (const action of data.actions) action.due += 10000;
      return {
        id: launchId(testConfig.chainId, testConfig.creator, claim),
        revision: 1,
        state: 'ARMED',
        error: null,
        data: JSON.stringify(data),
        updated_at: claim,
        report_pending: 0
      };
    });
    await sqlExecutor.execute(
      `UPDATE ${DROP_FORGE_LAUNCHES_TABLE} SET updated_at = 1 WHERE id = :id`,
      { id }
    );
    await sqlExecutor.bulkInsert(
      DROP_FORGE_LAUNCHES_TABLE,
      launches,
      Object.keys(launches[0])
    );
    await worker.tick();
    const dueId = launchId(testConfig.chainId, testConfig.creator, 21);
    const due = (await repository.find(dueId, {}))!;
    expect(due.data.actions[0].state).toBe('RESERVED');
    expect((await read())!.data.actions[0].state).toBe('PENDING');
    expect(chain.prepare).toHaveBeenCalledTimes(1);
  });
  it('does not reopen a cancelled launch when signing fails', async () => {
    await worker.tick();
    await acknowledgeReports();
    signer.sign.mockImplementation(async () => {
      await repository.change(
        id,
        async (record) => {
          setLaunchState(record, 'CANCELLED', 'Cancelled during signing');
        },
        {}
      );
      throw new Error('KMS unavailable');
    });
    await worker.tick();
    await worker.tick();
    expect((await read())!.state).toBe('CANCELLED');
    expect((await read())!.data.actions[0].state).toBe('PENDING');
    expect(chain.broadcast).not.toHaveBeenCalled();
  });
  it('preserves cancellation while recording a reverted outstanding receipt', async () => {
    await start();
    await repository.change(
      id,
      async (record) => {
        setLaunchState(record, 'CANCELLED', 'Cancelled');
      },
      {}
    );
    chain.receipt.mockResolvedValue({
      status: 0,
      blockNumber: 100,
      blockHash: 'block',
      confirmations: 12
    });
    await worker.tick();
    const saved = (await read())!;
    expect(saved.state).toBe('CANCELLED');
    expect(saved.data.actions[0].state).toBe('FAILED');
    expect(
      saved.data.events.some(
        (event) => event.error && event.content.includes('reverted')
      )
    ).toBe(true);
  });
  it('rechecks receipt when inclusion races the signer nonce read', async () => {
    await start();
    chain.receipt.mockResolvedValueOnce(null).mockResolvedValueOnce({
      status: 1,
      blockNumber: 100,
      blockHash: 'block',
      confirmations: 12
    });
    chain.nonce.mockResolvedValue(1);
    await worker.tick();
    expect((await read())!.state).toBe('RUNNING');
    expect((await read())!.data.actions[0].state).toBe('CONFIRMED');
    expect(chain.broadcast).toHaveBeenCalledTimes(1);
  });
  it('retains signed intent through an unavailable receipt block and confirms it exactly once', async () => {
    await start();
    const original = (await read())!.data.actions[0];
    const provider = {
      getTransactionReceipt: jest.fn().mockResolvedValue({
        status: 1,
        blockNumber: 100,
        blockHash: 'block',
        confirmations: async () => 12
      }),
      getBlock: jest.fn()
    };
    const ethereum = new EthereumLaunchChain(
      testConfig,
      provider as unknown as JsonRpcProvider
    );
    chain.receipt.mockImplementation((hash) => ethereum.receipt(hash));
    chain.nonce.mockResolvedValue(1);
    provider.getBlock.mockResolvedValue(null);
    await expect(worker.tick()).rejects.toBeInstanceOf(
      LaunchRpcUnavailableError
    );
    const deferred = (await read())!;
    expect(deferred.state).toBe('RUNNING');
    expect(deferred.data.actions[0]).toEqual(original);
    await repository.wallet(
      `${testConfig.chainId}:${testConfig.signer.toLowerCase()}`,
      async (pending) => {
        expect(pending).toMatchObject({
          launch_id: id,
          action_id: original.id
        });
      },
      {}
    );
    expect(signer.sign).toHaveBeenCalledTimes(1);
    expect(chain.broadcast).toHaveBeenCalledTimes(1);
    provider.getBlock.mockResolvedValue({ hash: 'block' });
    await worker.tick();
    const confirmed = (await read())!;
    expect(confirmed.data.actions[0].state).toBe('CONFIRMED');
    expect(confirmed.data.actions[0].hash).toBe(original.hash);
    expect(signer.sign).toHaveBeenCalledTimes(1);
    expect(chain.broadcast).toHaveBeenCalledTimes(1);
    await repository.wallet(
      `${testConfig.chainId}:${testConfig.signer.toLowerCase()}`,
      async (pending) => {
        expect(pending).toMatchObject({ launch_id: null, action_id: null });
      },
      {}
    );
  });
  it('keeps confirmed work runnable when its canonical block is temporarily unavailable', async () => {
    await start();
    chain.receipt.mockResolvedValue({
      status: 1,
      blockNumber: 100,
      blockHash: 'block',
      confirmations: 12
    });
    await worker.tick();
    await acknowledgeReports();
    chain.receipt.mockRejectedValueOnce(
      new LaunchRpcUnavailableError('Receipt block unavailable')
    );
    await expect(worker.tick()).rejects.toBeInstanceOf(
      LaunchRpcUnavailableError
    );
    expect((await read())!.state).toBe('RUNNING');
    expect((await read())!.data.actions[0].state).toBe('CONFIRMED');
    await worker.tick();
    expect((await read())!.data.actions[1].state).toBe('RESERVED');
    expect(signer.sign).toHaveBeenCalledTimes(1);
  });
  it('checks one chain descendant instead of all historical batch receipts', async () => {
    await repository.change(
      id,
      async (record) => {
        const template = record.data.actions[0];
        record.data.actions = Array.from({ length: 200 }, (_, index) => ({
          ...template,
          id: 'batch-' + index,
          state: 'CONFIRMED' as const,
          hash: 'hash-' + index,
          block_hash: 'block'
        }));
      },
      {}
    );
    chain.receipt.mockResolvedValue({
      status: 1,
      blockNumber: 100,
      blockHash: 'block',
      confirmations: 12
    });
    await worker.tick();
    expect(chain.receipt).toHaveBeenCalledTimes(1);
    expect(chain.receipt).toHaveBeenCalledWith('hash-199');
    expect((await read())!.state).toBe('COMPLETED');
  });
  it('blocks a reorg of the latest confirmed action before reserving another', async () => {
    await start();
    chain.receipt.mockResolvedValue({
      status: 1,
      blockNumber: 100,
      blockHash: 'block',
      confirmations: 12
    });
    await worker.tick();
    await acknowledgeReports();
    chain.receipt.mockResolvedValue(null);
    await worker.tick();
    expect((await read())!.state).toBe('BLOCKED');
    expect(signer.sign).toHaveBeenCalledTimes(1);
  });
  it('requires wave reporting before starting new transactions', async () => {
    await repository.change(
      id,
      async (record) => {
        record.data.events.push({
          id: 'armed',
          at: 1,
          error: false,
          content: 'Armed'
        });
      },
      {}
    );
    await worker.tick();
    expect(signer.sign).not.toHaveBeenCalled();
  });
});

describe('scheduled groups and manual takeover', () => {
  beforeEach(clearDropForgeTestTables);
  afterEach(() => jest.restoreAllMocks());
  async function setup() {
    const repository = new DropForgeRepository();
    jest.spyOn(repository, 'source').mockResolvedValue(testSource);
    const data = testLaunchData();
    const id = launchId(testConfig.chainId, testConfig.creator, 1);
    await repository.putDraft(id, 0, data, {});
    await repository.change(
      id,
      async (record) => {
        record.state = 'RUNNING';
      },
      {}
    );
    const unsigned = Transaction.from({
      chainId: testConfig.chainId,
      nonce: 0,
      to: testConfig.proxy,
      data: '0x1234',
      gasLimit: 50000,
      gasPrice: 1
    }).unsignedSerialized;
    const chain: jest.Mocked<LaunchChain> = {
      now: jest.fn().mockResolvedValue(1100),
      nonce: jest.fn().mockResolvedValue(0),
      prepare: jest.fn().mockRejectedValue(new Error('unfunded')),
      completed: jest.fn().mockResolvedValue(null),
      verify: jest.fn().mockResolvedValue(undefined),
      receipt: jest.fn().mockResolvedValue(null),
      broadcast: jest.fn().mockResolvedValue(undefined),
      inspectTransaction: jest.fn()
    };
    const signer = {
      sign: jest.fn((raw: string) =>
        testWallet.signTransaction(Transaction.from(raw))
      )
    };
    const worker = new DropForgeWorker(testConfig, repository, chain, signer);
    const acknowledge = () =>
      repository.change(
        id,
        async (record) => {
          record.data.events.forEach((event) => {
            event.drop_id = event.id;
          });
        },
        {}
      );
    return {
      id,
      repository,
      chain,
      signer,
      worker,
      acknowledge,
      unsigned,
      read: () => repository.find(id, {})
    };
  }
  it('reports each failed readiness check, then skips manual init and Phase 0 delivery and runs the next group without Resume', async () => {
    const f = await setup();
    await f.worker.tick();
    let saved = (await f.read())!;
    expect(saved.state).toBe('RUNNING');
    expect(
      saved.data.actions.slice(0, 2).every((action) => !!action.attempt_error)
    ).toBe(true);
    expect(saved.data.events.filter((event) => event.error)).toHaveLength(2);
    await f.acknowledge();
    const receipt = {
      status: 1,
      confirmations: 12,
      blockHash: 'manual',
      blockNumber: 100
    };
    f.chain.receipt.mockResolvedValue(receipt);
    jest.mocked(f.chain.inspectTransaction!).mockResolvedValue({
      receipt,
      calldata: claimAbi.encodeFunctionData('airdrop', [
        testConfig.creator,
        1,
        [testSource.rows[0].wallet],
        [1]
      ])
    });
    await f.repository.change(
      f.id,
      async (record) => {
        record.data.manual_transactions = [
          { hash: 'manual-airdrop', state: 'PENDING', action: 'PHASE0_AIRDROP' }
        ];
      },
      {}
    );
    f.chain.now.mockResolvedValue(5001);
    jest
      .mocked(f.chain.completed!)
      .mockImplementation(async (_, action) =>
        action.kind === 'INITIALIZE'
          ? { total: 1, metadata: testSource.metadata }
          : null
      );
    f.chain.prepare.mockResolvedValue(f.unsigned);
    await f.worker.tick(); // confirmed manual allocation and its outbox
    await f.acknowledge();
    await f.worker.tick(); // observe init even though the opening window expired
    saved = (await f.read())!;
    expect(saved.data.actions[0].state).toBe('CONFIRMED');
    expect(saved.data.actions[1].state).toBe('CONFIRMED');
    expect(saved.data.actions[2].state).toBe('RESERVED');
    expect(
      f.chain.prepare.mock.calls[f.chain.prepare.mock.calls.length - 1][1]
    ).toMatchObject({ kind: 'UPDATE', phase: 1 });
    expect(
      saved.data.events.filter((event) => event.content.includes('Skipped'))
    ).toHaveLength(2);
    await f.acknowledge();
    await f.worker.tick();
    expect(f.signer.sign).toHaveBeenCalledTimes(1);
    expect(
      f.chain.prepare.mock.calls.filter((call) => call[1].kind === 'AIRDROP')
    ).toHaveLength(1); // only the original failed readiness attempt
  });
  it('does not let an expired uncompleted group prevent the next scheduled readiness attempt', async () => {
    const f = await setup();
    f.chain.now.mockResolvedValue(5001);
    await f.worker.tick();
    const saved = (await f.read())!;
    expect(saved.state).toBe('RUNNING');
    expect(saved.data.actions[0].window_reported).toBe(true);
    expect(saved.data.actions[1].state).toBe('PENDING');
    expect(f.chain.prepare).toHaveBeenCalledTimes(1);
    expect(f.chain.prepare.mock.calls[0][1]).toMatchObject({
      phase: 1,
      kind: 'UPDATE'
    });
    expect(saved.data.actions[2].attempt_count).toBe(1);
  });
  it('retries unfunded actions after the retry interval and preserves the wave report boundary', async () => {
    const f = await setup();
    await f.worker.tick();
    await f.acknowledge();
    await f.worker.tick();
    expect(f.chain.prepare).toHaveBeenCalledTimes(2);
    f.chain.now.mockResolvedValue(1160);
    f.chain.prepare.mockResolvedValue(f.unsigned);
    await f.worker.tick();
    expect((await f.read())!.data.actions[0].state).toBe('RESERVED');
    expect(f.signer.sign).not.toHaveBeenCalled();
    await f.acknowledge();
    await f.worker.tick();
    expect(f.signer.sign).toHaveBeenCalledTimes(1);
  });
});
