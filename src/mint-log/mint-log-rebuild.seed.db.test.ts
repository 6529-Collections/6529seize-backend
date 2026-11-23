import 'reflect-metadata';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DROPS_TABLE,
  SIGNED_RECORD_LOG_ENTRIES_TABLE,
  SIGNED_RECORD_LOG_SEGMENTS_TABLE
} from '@/constants';
import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import { recordLogDb } from '@/signed-records/record-log/record-log.db';
import { RecordLogWriter } from '@/signed-records/record-log/record-log.service';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { closeRecordLog, recordLogStart } from './mint-log-rebuild.seed';

/** A records service for the test, with a key made only for it. */
const SERVICE = {
  waveId: '00000000-0000-4000-8000-00000000f0a1',
  profileId: 'mint-seed-test-records-service',
  wallet: '0x00000000000000000000000000000000000000f1'
};
const ENV = {
  SIGNED_RECORDS_WAVE_ID: SERVICE.waveId,
  SIGNED_RECORDS_SERVICE_PROFILE_ID: SERVICE.profileId,
  SIGNED_RECORDS_SERVICE_WALLET: SERVICE.wallet,
  SIGNED_RECORDS_PROVIDER_KEYS: JSON.stringify([
    {
      id: 'mint-seed-test',
      private_key: `0x${createHash('sha256')
        .update('mint seed test: a provider key made only for this test')
        .digest('hex')}`
    }
  ])
};

const writer = new RecordLogWriter(recordLogDb, {
  findGrantProofs: async () => []
} as unknown as ConstructorParameters<typeof RecordLogWriter>[1]);

function entry(lane: string, kind: string): RecordLogEntry {
  return { t: 'entry', lane, chain: 'public', body: { kind } };
}

async function openEntries(): Promise<string[]> {
  return (
    await sqlExecutor.execute<{ lane: string }>(
      `select lane from ${SIGNED_RECORD_LOG_ENTRIES_TABLE}
       where segment_seq is null order by id`
    )
  ).map((row) => row.lane);
}

async function count(sql: string, params?: Record<string, unknown>) {
  const [row] = await sqlExecutor.execute<{ n: number | string }>(sql, params);
  return Number(row.n);
}

describeWithSeed('the mint seed closing its record log entries', [], () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mint-seed-log-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('closes every entry its run wrote, not only mint ones', async () => {
    const start = await recordLogStart();
    // The phase split journals a subs entry once the subscriptions' switch is on.
    await writer.append(
      [entry('mint', 'dist.phase'), entry('subs', 'phase')],
      {}
    );

    await closeRecordLog(dir, ENV, start);

    expect(await openEntries()).toEqual([]);
    expect(
      await count(
        `select count(*) as n from ${SIGNED_RECORD_LOG_SEGMENTS_TABLE}`
      )
    ).toBe(1);
    // The segment's head drop, posted in the records wave as the service.
    expect(
      await count(
        `select count(*) as n from ${DROPS_TABLE}
         where wave_id = :waveId and author_id = :profileId`,
        SERVICE
      )
    ).toBe(2);
    const listed = JSON.parse(
      fs.readFileSync(path.join(dir, 'files.json'), 'utf8')
    );
    expect(Object.keys(listed)).toHaveLength(1);
  });

  it('refuses entries another seed left open, and closes nothing', async () => {
    await writer.append([entry('personal', 'personal-import')], {});
    const start = await recordLogStart();
    await writer.append([entry('mint', 'dist.phase')], {});

    await expect(closeRecordLog(dir, ENV, start)).rejects.toThrow(
      'The record log holds open entries of personal from before the mint seed'
    );
    expect(await openEntries()).toEqual(['personal', 'mint']);
    expect(
      await count(
        `select count(*) as n from ${SIGNED_RECORD_LOG_SEGMENTS_TABLE}`
      )
    ).toBe(0);
  });

  it('writes nothing when its run left no entry open', async () => {
    const start = await recordLogStart();

    await closeRecordLog(dir, ENV, start);

    expect(
      await count(
        `select count(*) as n from ${SIGNED_RECORD_LOG_SEGMENTS_TABLE}`
      )
    ).toBe(0);
    expect(fs.existsSync(path.join(dir, 'files.json'))).toBe(false);
    // Nor the records service: no wave, no drop.
    expect(
      await count(
        `select count(*) as n from ${DROPS_TABLE} where wave_id = :waveId`,
        SERVICE
      )
    ).toBe(0);
  });
});
