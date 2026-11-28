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
import { DropType } from '@/entities/IDrop';
import {
  worldActorProfileId,
  worldActorWallet
} from '@/rebuild/manifests/probe-fixture';
import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import { recordLogDb } from '@/signed-records/record-log/record-log.db';
import { RecordLogWriter } from '@/signed-records/record-log/record-log.service';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { writeWorldActorsForTests } from '@/tests/fixtures/world-actors.fixture';
import { closeRecordLog, recordLogStart } from './mint-log-rebuild.seed';
import {
  assertLatestDropTimes,
  insertDrop,
  insertWave,
  SEEDED_AT
} from './mint-log-rebuild.seed-rows';

/**
 * The records service: the world's actor, with a records wave and a key
 * made only for the test.
 */
const SERVICE = {
  waveId: '00000000-0000-4000-8000-00000000f0a1',
  profileId: worldActorProfileId('records-service'),
  wallet: worldActorWallet('records-service')
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

/**
 * The seed's drops carry the metrics 6529.io's drop creation writes. Each
 * listed wave has the drops given; its wave_metrics row holds the counts and
 * latest drop time those drops give, and so does each author's
 * wave_dropper_metrics row, with no row for anyone else. Plain SQL, not the
 * recount, so the recount isn't checked against itself.
 */
async function expectDropMetrics(
  waves: readonly {
    readonly waveId: string;
    readonly chat: number;
    readonly participatory: number;
  }[]
): Promise<void> {
  for (const wave of waves) {
    const [want] = await sqlExecutor.execute<{
      chat: number;
      participatory: number;
      latest: number;
    }>(
      `select sum(drop_type = 'CHAT') as chat,
              sum(drop_type = 'PARTICIPATORY') as participatory,
              max(created_at) as latest
         from drops where wave_id = :waveId`,
      { waveId: wave.waveId }
    );
    expect(Number(want.chat)).toBe(wave.chat);
    expect(Number(want.participatory)).toBe(wave.participatory);
    const [row] = await sqlExecutor.execute<{
      drops_count: number;
      participatory_drops_count: number;
      latest_drop_timestamp: number;
    }>(
      `select drops_count, participatory_drops_count, latest_drop_timestamp
         from wave_metrics where wave_id = :waveId`,
      { waveId: wave.waveId }
    );
    expect(row).toBeDefined();
    expect(Number(row.drops_count)).toBe(wave.chat);
    expect(Number(row.participatory_drops_count)).toBe(wave.participatory);
    expect(Number(row.latest_drop_timestamp)).toBe(Number(want.latest));
    const [droppers] = await sqlExecutor.execute<{
      dropper_rows: number;
      authors: number;
    }>(
      `select (select count(*) from wave_dropper_metrics
                where wave_id = :waveId) as dropper_rows,
              (select count(distinct author_id) from drops
                where wave_id = :waveId) as authors`,
      { waveId: wave.waveId }
    );
    expect(Number(droppers.dropper_rows)).toBe(Number(droppers.authors));
  }
  const authorsOff = await sqlExecutor.execute(
    `select d.wave_id, d.author_id
       from (select wave_id, author_id,
                    sum(drop_type = 'CHAT') as chat,
                    sum(drop_type = 'PARTICIPATORY') as participatory,
                    max(created_at) as latest
               from drops
              where wave_id in (:waveIds)
              group by wave_id, author_id) d
       left join wave_dropper_metrics m
         on m.wave_id = d.wave_id and m.dropper_id = d.author_id
      where m.wave_id is null
         or m.drops_count <> d.chat
         or m.participatory_drops_count <> d.participatory
         or m.latest_drop_timestamp <> d.latest`,
    { waveIds: waves.map((wave) => wave.waveId) }
  );
  expect(authorsOff).toEqual([]);
}

describeWithSeed('the mint seed closing its record log entries', [], () => {
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mint-seed-log-'));
    // The records service, as the identity world holds it.
    await writeWorldActorsForTests(['records-service']);
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
    // The records wave's description and head drops, with their metrics.
    await expectDropMetrics([
      { waveId: SERVICE.waveId, chat: 2, participatory: 0 }
    ]);
  });

  it('closes its entries after another seed posted heads in the records wave', async () => {
    // Another seed that writes the records wave without its description
    // drop, then posts a head drop with its metrics.
    await insertDrop({
      id: '00000000-0000-4000-8000-00000000f0a9',
      waveId: SERVICE.waveId,
      authorId: SERVICE.profileId,
      createdAt: Date.now() - 60_000,
      dropType: DropType.CHAT,
      content: 'Another seed head drop.',
      authorFollows: false
    });
    const start = await recordLogStart();
    await writer.append([entry('mint', 'dist.phase')], {});

    await closeRecordLog(dir, ENV, start);
    await assertLatestDropTimes([SERVICE.waveId]);

    // That head, the description written now at SEEDED_AT, and this run's head.
    await expectDropMetrics([
      { waveId: SERVICE.waveId, chat: 3, participatory: 0 }
    ]);
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

describeWithSeed("the mint seed's drops", [], () => {
  const WAVE = '00000000-0000-4000-8000-00000000f0c1';
  const CREATOR = 'mint-seed-test-creator';
  const ARTIST = 'mint-seed-test-artist';

  it('write the metrics 6529.io writes for each created drop, once', async () => {
    // The description, a chat drop by the creator at SEEDED_AT.
    await insertWave({
      id: WAVE,
      createdBy: CREATOR,
      descriptionDropId: '00000000-0000-4000-8000-00000000f0c2'
    });
    const artwork = {
      id: '00000000-0000-4000-8000-00000000f0c3',
      waveId: WAVE,
      authorId: ARTIST,
      createdAt: SEEDED_AT + 60_000,
      dropType: DropType.PARTICIPATORY,
      content: 'An artwork for the test.'
    };
    await insertDrop(artwork);
    // A drop already there adds nothing.
    await insertDrop(artwork);

    await expectDropMetrics([{ waveId: WAVE, chat: 1, participatory: 1 }]);
    const droppers = await sqlExecutor.execute<{
      dropper_id: string;
      drops_count: number;
      participatory_drops_count: number;
      latest_drop_timestamp: number;
    }>(
      `select dropper_id, drops_count, participatory_drops_count,
              latest_drop_timestamp
         from wave_dropper_metrics where wave_id = :wave order by dropper_id`,
      { wave: WAVE }
    );
    expect(
      droppers.map((row) => [
        row.dropper_id,
        Number(row.drops_count),
        Number(row.participatory_drops_count),
        Number(row.latest_drop_timestamp)
      ])
    ).toEqual([
      [ARTIST, 0, 1, SEEDED_AT + 60_000],
      [CREATOR, 1, 0, SEEDED_AT]
    ]);
  });

  it("leave a wave's latest drop time behind when written out of order, which the end check finds", async () => {
    await insertWave({
      id: WAVE,
      createdBy: CREATOR,
      descriptionDropId: '00000000-0000-4000-8000-00000000f0c2'
    });
    const drop = {
      waveId: WAVE,
      authorId: ARTIST,
      dropType: DropType.CHAT,
      content: 'A drop for the test.'
    };
    await insertDrop({
      ...drop,
      id: '00000000-0000-4000-8000-00000000f0c4',
      createdAt: SEEDED_AT + 60_000
    });
    await assertLatestDropTimes([WAVE]);
    await insertDrop({
      ...drop,
      id: '00000000-0000-4000-8000-00000000f0c5',
      createdAt: SEEDED_AT + 30_000
    });

    await expect(assertLatestDropTimes([WAVE])).rejects.toThrow(
      "isn't its newest drop's"
    );
    // A newer drop brings it back, as the seed's own head drops do.
    await insertDrop({
      ...drop,
      id: '00000000-0000-4000-8000-00000000f0c6',
      createdAt: SEEDED_AT + 90_000
    });
    await assertLatestDropTimes([WAVE]);
  });
});
