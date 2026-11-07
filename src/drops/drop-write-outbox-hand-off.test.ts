import {
  asDropWriteOutboxJob,
  handOffDropWriteOutbox
} from './drop-write-outbox.hand-off';
import { sweepDropWriteOutbox } from '../dropWriteOutboxLoop/sweep';
import { Logger } from '@/logging';

describe('post outbox hand-off (waves 1.8)', () => {
  it('hands nothing off without an outbox row', async () => {
    const queue = { enqueue: jest.fn() };
    await expect(
      handOffDropWriteOutbox(
        { outboxId: null, dropId: 'd', waveId: 'w' },
        {},
        queue
      )
    ).resolves.toBe('nothing');
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('queues one job and reports a refused one as left to the sweeper', async () => {
    const queue = { enqueue: jest.fn().mockResolvedValue([]) };
    await expect(
      handOffDropWriteOutbox(
        { outboxId: 7, dropId: 'd', waveId: 'w' },
        {},
        queue
      )
    ).resolves.toBe('queued');
    queue.enqueue.mockImplementation(async (jobs: unknown[]) => jobs);
    await expect(
      handOffDropWriteOutbox(
        { outboxId: 7, dropId: 'd', waveId: 'w' },
        {},
        queue
      )
    ).resolves.toBe('left_to_sweeper');
  });

  it('validates a queued job body', () => {
    expect(
      asDropWriteOutboxJob({
        kind: 'drop_write_outbox',
        outbox_id: 7,
        drop_id: 'd',
        wave_id: 'w'
      })
    ).toMatchObject({ outbox_id: 7 });
    for (const bad of [
      { kind: 'drop_frames', outbox_id: 7, drop_id: 'd', wave_id: 'w' },
      { kind: 'drop_write_outbox', outbox_id: 0, drop_id: 'd', wave_id: 'w' },
      { kind: 'drop_write_outbox', outbox_id: 'x', drop_id: 'd', wave_id: 'w' },
      { kind: 'drop_write_outbox', outbox_id: 7, wave_id: 'w' }
    ]) {
      expect(() => asDropWriteOutboxJob(bad)).toThrow('Invalid');
    }
  });
});

describe('sweepDropWriteOutbox', () => {
  let errors: jest.SpyInstance;
  beforeEach(() => {
    errors = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const reported = (name: string) =>
    errors.mock.calls.filter(([, error]) => (error as Error)?.name === name)
      .length;

  it('processes due rows and stops when a batch makes no progress', async () => {
    const db = {
      oldestPendingAt: jest.fn().mockResolvedValue(null),
      quarantineExhausted: jest.fn().mockResolvedValue(0),
      findDue: jest
        .fn()
        .mockResolvedValueOnce([1, 2, 3])
        .mockResolvedValueOnce([3])
    };
    const processor = {
      process: jest
        .fn()
        .mockResolvedValueOnce('processed')
        .mockResolvedValueOnce('already_done_or_claimed')
        .mockRejectedValueOnce(new Error('boom'))
        .mockRejectedValueOnce(new Error('boom'))
    };

    await expect(
      sweepDropWriteOutbox({ db, processor, batchSize: 3 })
    ).resolves.toEqual({ processed: 1, skipped: 1, failed: 2 });
    // The second batch made no progress, so the sweep stopped there.
    expect(db.findDue).toHaveBeenCalledTimes(2);
    expect(reported('DropWriteOutbox.BACKLOG')).toBe(0);
    expect(reported('DropWriteOutbox.QUARANTINED')).toBe(0);
  });

  it('reports a backlog older than five minutes', async () => {
    const now = Date.now();
    const db = {
      oldestPendingAt: jest.fn().mockResolvedValue(now - 6 * 60_000),
      quarantineExhausted: jest.fn().mockResolvedValue(0),
      findDue: jest.fn().mockResolvedValue([])
    };
    await expect(
      sweepDropWriteOutbox({ db, processor: { process: jest.fn() } })
    ).resolves.toEqual({ processed: 0, skipped: 0, failed: 0 });
    expect(reported('DropWriteOutbox.BACKLOG')).toBe(1);
    // Leased (in-flight) rows are not a backlog: the query is lease-aware.
    expect(db.oldestPendingAt).toHaveBeenCalledWith({ leaseMs: 60_000 });
  });

  it('reports newly quarantined rows once', async () => {
    const db = {
      oldestPendingAt: jest.fn().mockResolvedValue(null),
      quarantineExhausted: jest
        .fn()
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(0),
      findDue: jest.fn().mockResolvedValue([])
    };
    const processor = { process: jest.fn() };

    await sweepDropWriteOutbox({ db, processor });
    await sweepDropWriteOutbox({ db, processor });

    expect(reported('DropWriteOutbox.QUARANTINED')).toBe(1);
  });
});
