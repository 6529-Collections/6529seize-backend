import { Transaction } from 'ethers';
import { DropForgeWorker } from '@/drop-forge/drop-forge.worker';
import {
  DropForgeRepository,
  launchId,
  setLaunchState
} from '@/drop-forge/drop-forge.repository';
import { LaunchChain } from '@/drop-forge/drop-forge.chain';
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
  it('records a late initialization receipt without allowing dependent transactions', async () => {
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
    expect(saved.state).toBe('BLOCKED');
    expect(saved.error).toContain('Confirmation deadline missed');
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
    expect(saved.state).toBe('BLOCKED');
    expect(saved.data.actions[0].state).toBe('RESERVED');
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
    expect((await read())!.state).toBe('BLOCKED');
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
    expect((await read())!.state).toBe('BLOCKED');
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
