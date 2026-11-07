import 'reflect-metadata';
import {
  DROPS_TABLE,
  IDENTITY_NOTIFICATIONS_TABLE,
  WAVE_READER_METRICS_TABLE
} from '@/constants';
import { DropType } from '@/entities/IDrop';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { IdentityNotificationsDb } from '@/notifications/identity-notifications.db';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { WavesApiDb } from './waves.api.db';

const repo = new WavesApiDb(() => sqlExecutor);
const notificationsDb = new IdentityNotificationsDb(() => sqlExecutor);
const ctx: RequestContext = {};
const reader = 'reader-1';
const chatWave = aWave({}, { id: 'watermark-chat', name: 'watermark chat' });
const dmWave = aWave(
  { is_direct_message: true },
  { id: 'watermark-dm', name: 'watermark dm' }
);
const emptyWave = aWave({}, { id: 'watermark-empty', name: 'watermark empty' });
const base = Date.now() - 60_000;

function drop(waveId: string, serialNo: number) {
  return {
    serial_no: serialNo,
    id: `${waveId}-${serialNo}`,
    wave_id: waveId,
    author_id: 'author-1',
    created_at: base + serialNo,
    updated_at: null,
    title: null,
    parts_count: 1,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    drop_type: DropType.CHAT,
    signature: null,
    is_additional_action_promised: null,
    hide_link_preview: false
  };
}

async function addDrop(waveId: string, serialNo: number) {
  const row = drop(waveId, serialNo);
  await sqlExecutor.execute(
    `insert into ${DROPS_TABLE} (serial_no, id, wave_id, author_id, created_at, parts_count, drop_type)
     values (:serial_no, :id, :wave_id, :author_id, :created_at, 1, 'CHAT')`,
    { ...row, created_at: Date.now() }
  );
}

async function storedRow(waveId: string) {
  return sqlExecutor.oneOrNull<{
    latest_read_timestamp: number;
    latest_read_serial_no: number | null;
    unread_state_version: number;
  }>(
    `select latest_read_timestamp, latest_read_serial_no, unread_state_version
     from ${WAVE_READER_METRICS_TABLE} where wave_id = :waveId and reader_id = :reader`,
    { waveId, reader }
  );
}

/**
 * Counts INSERT/UPDATE statements. Repositories keep the executor they first
 * saw while each test installs a new one, so spy on the shared prototype.
 */
function countWrites() {
  const prototype = Object.getPrototypeOf(sqlExecutor);
  const original = prototype.execute;
  let writes = 0;
  const spy = jest
    .spyOn(prototype, 'execute')
    .mockImplementation(async function (
      this: unknown,
      sql: unknown,
      ...rest: unknown[]
    ) {
      if (typeof sql === 'string' && /^\s*(insert|update)\b/i.test(sql)) {
        writes++;
      }
      return original.call(this, sql, ...rest);
    });
  return {
    get writes() {
      return writes;
    },
    restore: () => spy.mockRestore()
  };
}

describeWithSeed(
  'Wave read watermark (waves plan 1.7)',
  [
    withWaves([chatWave, dmWave, emptyWave]),
    {
      table: DROPS_TABLE,
      rows: [1, 2, 3].flatMap((serial) => [
        drop(chatWave.id, serial),
        drop(dmWave.id, 100 + serial)
      ])
    }
  ],
  () => {
    afterEach(() => jest.restoreAllMocks());

    it('writes the first read, then skips repeated reads', async () => {
      const first = await repo.advanceWaveReadWatermark(
        { waveId: chatWave.id, readerId: reader },
        ctx
      );
      expect(first).toMatchObject({
        changed: true,
        watermark: { latest_read_serial_no: 3, version: 1 }
      });
      expect(first.watermark!.latest_read_timestamp).toBeGreaterThanOrEqual(
        base + 3
      );

      const counter = countWrites();
      const again = await repo.advanceWaveReadWatermark(
        { waveId: chatWave.id, readerId: reader },
        ctx
      );
      counter.restore();

      expect(again).toEqual({ changed: false, watermark: first.watermark });
      expect(counter.writes).toBe(0);
    });

    it('moves forward with a new drop and bumps the version', async () => {
      await repo.advanceWaveReadWatermark(
        { waveId: chatWave.id, readerId: reader },
        ctx
      );
      await addDrop(chatWave.id, 4);

      const next = await repo.advanceWaveReadWatermark(
        { waveId: chatWave.id, readerId: reader },
        ctx
      );

      expect(next).toMatchObject({
        changed: true,
        watermark: { latest_read_serial_no: 4, version: 2 }
      });
    });

    it('cuts the writes of a read burst to the reads that move the watermark', async () => {
      const counter = countWrites();
      let changes = 0;
      for (let i = 0; i < 20; i++) {
        if (i === 7) await addDrop(chatWave.id, 4);
        if (i === 14) await addDrop(chatWave.id, 5);
        const result = await repo.advanceWaveReadWatermark(
          { waveId: chatWave.id, readerId: reader },
          ctx
        );
        if (result.changed) changes++;
      }
      counter.restore();

      // 20 reads, 3 of them after new drops (the two inserts above count too).
      expect(changes).toBe(3);
      expect(counter.writes).toBe(3 + 2);
    });

    it('baseline: the previous read path writes twice on every read', async () => {
      const counter = countWrites();
      for (let i = 0; i < 20; i++) {
        if (i === 7) await addDrop(chatWave.id, 4);
        if (i === 14) await addDrop(chatWave.id, 5);
        await notificationsDb.markWaveNotificationsAsRead(
          chatWave.id,
          reader,
          ctx
        );
        await repo.updateWaveReaderMetricLatestReadTimestamp(
          chatWave.id,
          reader,
          ctx
        );
      }
      counter.restore();

      // 20 reads × (notification update + reader upsert), plus the 2 inserts.
      expect(counter.writes).toBe(40 + 2);
    });

    it('bumps the version once when two devices read at the same time', async () => {
      const first = await repo.advanceWaveReadWatermark(
        { waveId: chatWave.id, readerId: reader },
        ctx
      );
      await addDrop(chatWave.id, 4);

      const results = await Promise.all([
        repo.advanceWaveReadWatermark(
          { waveId: chatWave.id, readerId: reader },
          ctx
        ),
        repo.advanceWaveReadWatermark(
          { waveId: chatWave.id, readerId: reader },
          ctx
        )
      ]);

      // Both may report a change, but they converge on one version step.
      expect(results.some((it) => it.changed)).toBe(true);
      const final = await repo.findWaveReadWatermark(
        { waveId: chatWave.id, readerId: reader },
        ctx
      );
      expect(final).toMatchObject({
        latest_read_serial_no: 4,
        version: first.watermark!.version + 1
      });
    });

    it('bumps a DM version once when two devices read through the same drop', async () => {
      const first = await repo.advanceDirectMessageReadWatermark(
        { waveId: dmWave.id, readerId: reader, readThroughSerialNo: 101 },
        ctx
      );

      await Promise.all([
        repo.advanceDirectMessageReadWatermark(
          { waveId: dmWave.id, readerId: reader, readThroughSerialNo: 103 },
          ctx
        ),
        repo.advanceDirectMessageReadWatermark(
          { waveId: dmWave.id, readerId: reader, readThroughSerialNo: 103 },
          ctx
        )
      ]);

      const final = await repo.findWaveReadWatermark(
        { waveId: dmWave.id, readerId: reader },
        ctx
      );
      expect(final).toMatchObject({
        latest_read_serial_no: 103,
        version: first.watermark!.version + 1
      });
    });

    it('upgrades a legacy timestamp-only row once', async () => {
      await sqlExecutor.execute(
        `insert into ${WAVE_READER_METRICS_TABLE} (wave_id, reader_id, latest_read_timestamp)
         values (:waveId, :reader, :now)`,
        { waveId: chatWave.id, reader, now: Date.now() }
      );

      const upgraded = await repo.advanceWaveReadWatermark(
        { waveId: chatWave.id, readerId: reader },
        ctx
      );
      const again = await repo.advanceWaveReadWatermark(
        { waveId: chatWave.id, readerId: reader },
        ctx
      );

      expect(upgraded).toMatchObject({
        changed: true,
        watermark: { latest_read_serial_no: 3 }
      });
      expect(again.changed).toBe(false);
    });

    it('leaves an empty wave alone', async () => {
      const result = await repo.advanceWaveReadWatermark(
        { waveId: emptyWave.id, readerId: reader },
        ctx
      );

      expect(result).toEqual({ changed: false, watermark: null });
      expect(await storedRow(emptyWave.id)).toBeNull();
    });

    it('moves back on mark-unread with a newer version, and the next read moves forward', async () => {
      const read = await repo.advanceWaveReadWatermark(
        { waveId: chatWave.id, readerId: reader },
        ctx
      );
      const second = drop(chatWave.id, 2);

      await repo.setWaveReadWatermarkBeforeDrop(
        {
          waveId: chatWave.id,
          readerId: reader,
          dropSerialNo: second.serial_no,
          dropCreatedAt: second.created_at
        },
        ctx
      );
      const unread = await repo.findWaveReadWatermark(
        { waveId: chatWave.id, readerId: reader },
        ctx
      );
      const reread = await repo.advanceWaveReadWatermark(
        { waveId: chatWave.id, readerId: reader },
        ctx
      );

      expect(unread).toEqual({
        latest_read_serial_no: 1,
        latest_read_timestamp: second.created_at - 1,
        version: read.watermark!.version + 1
      });
      // Ordinary-wave unread counts compare created_at with the timestamp.
      expect(reread).toMatchObject({
        changed: true,
        watermark: {
          latest_read_serial_no: 3,
          version: read.watermark!.version + 2
        }
      });
    });

    it('advances a DM monotonically through the requested serial and skips no-op reads', async () => {
      const first = await repo.advanceDirectMessageReadWatermark(
        { waveId: dmWave.id, readerId: reader, readThroughSerialNo: 102 },
        ctx
      );
      const counter = countWrites();
      const same = await repo.advanceDirectMessageReadWatermark(
        { waveId: dmWave.id, readerId: reader, readThroughSerialNo: 102 },
        ctx
      );
      const older = await repo.advanceDirectMessageReadWatermark(
        { waveId: dmWave.id, readerId: reader, readThroughSerialNo: 101 },
        ctx
      );
      counter.restore();
      const newer = await repo.advanceDirectMessageReadWatermark(
        { waveId: dmWave.id, readerId: reader },
        ctx
      );

      expect(first).toMatchObject({
        changed: true,
        watermark: { latest_read_serial_no: 102 }
      });
      expect(same.changed).toBe(false);
      expect(older).toEqual({ changed: false, watermark: first.watermark });
      expect(counter.writes).toBe(0);
      expect(newer).toMatchObject({
        changed: true,
        watermark: { latest_read_serial_no: 103 }
      });
      expect(newer.watermark!.version).toBeGreaterThan(
        first.watermark!.version
      );
    });

    it('marks unread wave notifications once and skips the update when none are left', async () => {
      for (const id of [1, 2]) {
        await sqlExecutor.execute(
          `insert into ${IDENTITY_NOTIFICATIONS_TABLE}
             (identity_id, additional_identity_id, related_drop_id, related_drop_part_no,
              related_drop_2_id, related_drop_2_part_no, cause, additional_data,
              created_at, read_at, wave_id, visibility_group_id)
           values (:reader, 'author-1', :dropId, null, null, null, :cause, '{}',
                   :createdAt, null, :waveId, null)`,
          {
            reader,
            dropId: `${chatWave.id}-${id}`,
            cause: IdentityNotificationCause.IDENTITY_MENTIONED,
            createdAt: base + id,
            waveId: chatWave.id
          }
        );
      }

      const first = await notificationsDb.markUnreadWaveNotificationsAsRead(
        chatWave.id,
        reader,
        ctx
      );
      const counter = countWrites();
      const second = await notificationsDb.markUnreadWaveNotificationsAsRead(
        chatWave.id,
        reader,
        ctx
      );
      counter.restore();

      expect(first).toBe(2);
      expect(second).toBe(0);
      expect(counter.writes).toBe(0);
    });
  }
);
