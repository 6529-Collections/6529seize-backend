import { DROPS_PARTS_TABLE, DROPS_TABLE } from '@/constants';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import type { RecordsWaveDrop, RecordsWaveReader } from './record-log-reader';

const PAGE = 500;

/**
 * The records wave as 6529.io's own drops hold it: the drops the service
 * identity posted there (through the signed-drop path, so each carries
 * its device-signed event), oldest first. The closer reads it to continue
 * each chain from its last head; a rebuild reads the wave from the relays.
 */
export class LocalRecordsWaveReader
  extends LazyDbAccessCompatibleService
  implements RecordsWaveReader
{
  constructor(
    private readonly wave: {
      readonly waveId: string;
      readonly profileId: string;
      readonly wallet: string;
    },
    supplier = dbSupplier
  ) {
    super(supplier);
  }

  async *drops(): AsyncIterable<RecordsWaveDrop> {
    let after = 0;
    for (;;) {
      const rows = await this.db.execute<{
        id: string;
        serial_no: number | string;
        content: string | null;
      }>(
        `select d.id, d.serial_no, p.content
         from ${DROPS_TABLE} d
         join ${DROPS_PARTS_TABLE} p on p.drop_id = d.id and p.drop_part_id = 1
         where d.wave_id = :waveId and d.author_id = :profileId
           and d.serial_no > :after
         order by d.serial_no asc
         limit ${PAGE}`,
        { waveId: this.wave.waveId, profileId: this.wave.profileId, after }
      );
      for (const row of rows) {
        yield {
          dropId: row.id,
          author: this.wave.wallet,
          text: row.content ?? ''
        };
      }
      if (rows.length < PAGE) {
        return;
      }
      after = Number(rows[rows.length - 1].serial_no);
    }
  }
}
