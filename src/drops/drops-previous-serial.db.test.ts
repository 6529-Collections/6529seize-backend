import { DROPS_TABLE } from '@/constants/db-tables';
import { DropsDb } from '@/drops/drops.db';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';

const drop = (serialNo: number, waveId: string) => ({
  serial_no: serialNo,
  id: `drop-${serialNo}`,
  wave_id: waveId,
  author_id: 'author-1',
  created_at: 1000 + serialNo,
  parts_count: 1,
  drop_type: 'CHAT'
});

describeWithSeed(
  'DropsDb.findPreviousSerialNo (waves 1.5 gap marker)',
  {
    table: DROPS_TABLE,
    // Serials are global, so another wave's drops interleave with this one's.
    rows: [
      drop(10, 'wave-a'),
      drop(11, 'wave-b'),
      drop(12, 'wave-a'),
      drop(13, 'wave-b'),
      drop(14, 'wave-b'),
      drop(15, 'wave-a')
    ]
  },
  () => {
    const db = new DropsDb(() => sqlExecutor);

    it('returns the previous serial in the same wave, skipping other waves', async () => {
      await expect(
        db.findPreviousSerialNo({ waveId: 'wave-a', serialNo: 15 }, {})
      ).resolves.toBe(12);
      await expect(
        db.findPreviousSerialNo({ waveId: 'wave-b', serialNo: 14 }, {})
      ).resolves.toBe(13);
    });

    it('returns null for the first drop of a wave', async () => {
      await expect(
        db.findPreviousSerialNo({ waveId: 'wave-a', serialNo: 10 }, {})
      ).resolves.toBeNull();
      await expect(
        db.findPreviousSerialNo({ waveId: 'wave-c', serialNo: 99 }, {})
      ).resolves.toBeNull();
    });

    it('returns a number even though MySQL returns BIGINT max() as text', async () => {
      const previous = await db.findPreviousSerialNo(
        { waveId: 'wave-b', serialNo: 13 },
        {}
      );
      expect(previous).toBe(11);
      expect(typeof previous).toBe('number');
    });
  }
);
