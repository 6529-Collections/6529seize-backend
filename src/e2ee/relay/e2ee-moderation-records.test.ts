import { CONTENT_MODERATION_REPORTS_TABLE } from '@/constants/db-tables';
import {
  E2eeModerationRecorder,
  E2eeModerationRecorderDeps
} from '@/e2ee/relay/e2ee-moderation-records';
import { E2eeRecordBatch } from '@/e2ee/relay/e2ee-stream-publisher';

function recorder(input: { mode: 'off' | 'mirror'; failures?: number }) {
  const calls: { table: string; where: unknown }[] = [];
  const published: unknown[] = [];
  let failures = input.failures ?? 0;
  const batch = {} as E2eeRecordBatch;
  const deps: E2eeModerationRecorderDeps = {
    publisher: {
      mode: () => input.mode,
      batch: () => (input.mode === 'off' ? null : batch),
      afterCommit: async (b) => {
        published.push(b);
      }
    },
    writers: {
      moderationRowsChanged: async (_batch, _connection, change) => {
        if (failures > 0) {
          failures--;
          throw new Error('Lock wait timeout exceeded');
        }
        calls.push(change);
        return 1;
      }
    },
    runner: {
      executeNativeQueriesInTransaction: (work) =>
        work({ connection: {} } as never)
    }
  };
  return { recorder: new E2eeModerationRecorder(() => deps), calls, published };
}

describe('E2eeModerationRecorder', () => {
  it('does nothing while records are off', async () => {
    const { recorder: off, calls } = recorder({ mode: 'off' });
    await off.changed(CONTENT_MODERATION_REPORTS_TABLE, { id: 'r1' });
    expect(calls).toEqual([]);
  });

  it('records the rows once the write is committed, and publishes them', async () => {
    const { recorder: on, calls, published } = recorder({ mode: 'mirror' });
    await on.changed(CONTENT_MODERATION_REPORTS_TABLE, { drop_id: 'd1' });
    expect(calls).toEqual([
      { table: CONTENT_MODERATION_REPORTS_TABLE, where: { drop_id: 'd1' } }
    ]);
    expect(published).toHaveLength(1);
  });

  it('retries once, and never fails the report write', async () => {
    const once = recorder({ mode: 'mirror', failures: 1 });
    await expect(
      once.recorder.record(CONTENT_MODERATION_REPORTS_TABLE, { id: 'r1' })
    ).resolves.toBe(1);
    const twice = recorder({ mode: 'mirror', failures: 2 });
    await expect(
      twice.recorder.changed(CONTENT_MODERATION_REPORTS_TABLE, { id: 'r1' })
    ).resolves.toBeUndefined();
    expect(twice.calls).toEqual([]);
    expect(twice.published).toEqual([]);
  });
});
